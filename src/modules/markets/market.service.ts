import { Types } from 'mongoose';
import { publish } from '../../realtime/bus.js';
import { AppError } from '../../utils/errors.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { Match } from '../matches/match.model.js';
import { toSummary, type MatchSummaryView } from '../matches/match.views.js';
import { getSettings } from '../settings/settings.service.js';
import { reevaluateMatch } from './engine.js';
import { getBook } from './liability.js';
import { Market, type IMarket } from './market.model.js';
import { toAdminMarketView, toMarketView, type AdminMarketView, type MarketView } from './market.views.js';
import { MAX_ODDS, MIN_ODDS, toLadder } from './odds/ladder.js';
import { canTransition } from './stateMachine.js';
import type { MarketGroup, MarketStatus } from './types.js';

function oid(id: string, what: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound(what);
  return new Types.ObjectId(id);
}

async function load(id: string): Promise<IMarket> {
  const m = await Market.findById(oid(id, 'Market')).lean();
  if (!m) throw AppError.notFound('Market');
  return m;
}

export async function listMatchMarkets(matchId: string): Promise<MarketView[]> {
  const rows = await Market.find({ matchId: oid(matchId, 'Match'), status: { $ne: 'PENDING' } }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  return rows.map(toMarketView);
}

export async function getMarket(id: string): Promise<MarketView> {
  const m = await load(id);
  if (m.status === 'PENDING') throw AppError.notFound('Market');
  return toMarketView(m);
}

/** Home page: the Match Winner market of each live / upcoming bettable match, live first. */
export async function listFeatured(limit: number): Promise<Array<{ match: MatchSummaryView; market: MarketView }>> {
  const matches = await Match.find({ bettingEnabled: true, status: { $in: ['LIVE', 'INNINGS_BREAK', 'TOSS', 'UPCOMING'] } })
    .sort({ featured: -1, status: 1, startTime: 1 })
    .limit(limit * 2)
    .select('-squads')
    .lean();
  const markets = await Market.find({ matchId: { $in: matches.map((m) => m._id) }, type: 'MATCH_WINNER', status: { $in: ['OPEN', 'SUSPENDED'] } }).lean();
  const byMatch = new Map(markets.map((m) => [m.matchId.toString(), m]));
  const live = (s: string) => (['LIVE', 'INNINGS_BREAK', 'TOSS'].includes(s) ? 0 : 1);
  return matches
    .filter((m) => byMatch.has(m._id.toString()))
    .sort((a, b) => Number(b.featured) - Number(a.featured) || live(a.status) - live(b.status) || a.startTime.getTime() - b.startTime.getTime())
    .slice(0, limit)
    .map((m) => ({ match: toSummary(m), market: toMarketView(byMatch.get(m._id.toString())!) }));
}

export async function adminListMatchMarkets(matchId: string): Promise<AdminMarketView[]> {
  const rows = await Market.find({ matchId: oid(matchId, 'Match') }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  return Promise.all(rows.map(async (m) => toAdminMarketView(m, await getBook(m._id.toString(), m.selections.map((s) => s.id)))));
}

/** Writes a change with optimistic concurrency and broadcasts it. */
async function write(m: IMarket, set: Partial<IMarket>, kind: 'status' | 'odds'): Promise<IMarket> {
  const updated = await Market.findOneAndUpdate({ _id: m._id, version: m.version }, { $set: set, $inc: { version: 1 } }, { new: true, lean: true });
  if (!updated) throw new AppError('CONFLICT', 'Market changed while you were editing it; reload and retry');
  await publish('market.updated', { matchId: m.matchId.toString(), kind, market: toMarketView(updated) });
  return updated;
}

export interface CustomMarketInput {
  name: string;
  group?: MarketGroup;
  inPlay: boolean;
  selections: Array<{ name: string; odds: number }>;
  minStake?: number;
  maxStake?: number;
  maxLiability?: number;
  betDelayMs?: number;
  reason: string;
}

/** Admin-created market with fixed, manually set odds. The engine suspends/closes it but never reprices it. */
export async function createCustomMarket(actor: AuditActor, matchId: string, input: CustomMarketInput): Promise<AdminMarketView> {
  const match = await Match.findById(oid(matchId, 'Match')).select('_id status').lean();
  if (!match) throw AppError.notFound('Match');
  if (['COMPLETED', 'ABANDONED', 'NO_RESULT'].includes(match.status)) throw new AppError('INVALID_STATE', 'Match is finished');
  const settings = await getSettings();
  const doc = await Market.create({
    matchId: match._id,
    key: `CUSTOM:${new Types.ObjectId().toString()}`,
    type: 'CUSTOM',
    group: input.group ?? 'SPECIALS',
    name: input.name,
    params: {},
    selections: input.selections.map((s, i) => ({ id: `s${i + 1}`, name: s.name, teamKey: null, playerId: null, odds: toLadder(s.odds), probabilityBps: 0, status: 'ACTIVE' })),
    status: 'SUSPENDED',
    suspendReason: 'ADMIN',
    inPlay: input.inPlay,
    autoManaged: false,
    marginBps: 0,
    betDelayMs: input.betDelayMs ?? (input.inPlay ? settings.defaultBetDelayMs : 0),
    minStake: input.minStake ?? settings.globalMinStake,
    maxStake: input.maxStake ?? settings.globalMaxStake,
    maxLiability: input.maxLiability ?? settings.defaultMaxLiability,
    lineX10: null,
    sortOrder: 90,
    createdBy: `admin:${actor.id ?? 'unknown'}`,
  });
  await recordAudit(actor, { action: 'market.create', targetType: 'market', targetId: doc.id as string, reason: input.reason, after: { name: input.name, selections: input.selections } });
  // Created suspended so the admin can review it; reopening runs the normal checks.
  return toAdminMarketView(doc.toObject(), null);
}

export interface MarketEdit {
  name?: string;
  marginBps?: number;
  minStake?: number;
  maxStake?: number;
  maxLiability?: number;
  betDelayMs?: number;
  autoManaged?: boolean;
  /** Manual odds; only for markets that are (or are being made) admin-managed. */
  odds?: Record<string, number>;
  reason: string;
}

export async function editMarket(actor: AuditActor, id: string, edit: MarketEdit): Promise<AdminMarketView> {
  const m = await load(id);
  if (!['PENDING', 'OPEN', 'SUSPENDED'].includes(m.status)) throw new AppError('INVALID_STATE', `Cannot edit a ${m.status} market`);
  const minStake = edit.minStake ?? m.minStake;
  const maxStake = edit.maxStake ?? m.maxStake;
  if (minStake > maxStake) throw AppError.badRequest('minStake must be ≤ maxStake');
  const autoManaged = edit.autoManaged ?? m.autoManaged;
  if (edit.odds && autoManaged) throw AppError.badRequest('Set autoManaged=false to price this market by hand');
  if (m.type === 'CUSTOM' && autoManaged) throw AppError.badRequest('Custom markets are always priced by hand');

  const selections = edit.odds
    ? m.selections.map((s) => {
        const o = edit.odds?.[s.id];
        if (o === undefined) return s;
        if (o < MIN_ODDS || o > MAX_ODDS) throw AppError.badRequest(`Odds for ${s.id} must be within ${MIN_ODDS}–${MAX_ODDS}`);
        return { ...s, odds: toLadder(o) };
      })
    : m.selections;
  const set: Partial<IMarket> = {
    ...(edit.name ? { name: edit.name } : {}),
    ...(edit.marginBps !== undefined ? { marginBps: edit.marginBps } : {}),
    ...(edit.maxLiability !== undefined ? { maxLiability: edit.maxLiability } : {}),
    ...(edit.betDelayMs !== undefined ? { betDelayMs: edit.betDelayMs } : {}),
    minStake,
    maxStake,
    autoManaged,
    selections,
  };
  const updated = await write(m, set, edit.odds ? 'odds' : 'status');
  await recordAudit(actor, {
    action: 'market.edit', targetType: 'market', targetId: id, reason: edit.reason,
    before: { marginBps: m.marginBps, minStake: m.minStake, maxStake: m.maxStake, maxLiability: m.maxLiability, betDelayMs: m.betDelayMs, autoManaged: m.autoManaged, odds: Object.fromEntries(m.selections.map((s) => [s.id, s.odds])) },
    after: set,
  });
  await reevaluateMatch(m.matchId.toString()); // reprice with the new margin straight away
  return toAdminMarketView((await Market.findById(updated._id).lean()) ?? updated, null);
}

/** A stale admin tab can ask for a move that's no longer legal; that's a rejection, not a server fault. */
function assertAdminTransition(from: MarketStatus, to: MarketStatus): void {
  if (!canTransition(from, to)) throw new AppError('INVALID_STATE', `A ${from} market cannot move to ${to}`);
}

/** Manual suspension is sticky: the engine never reopens an ADMIN suspension. */
export async function suspendMarket(actor: AuditActor, id: string, reason: string): Promise<MarketView> {
  const m = await load(id);
  assertAdminTransition(m.status, 'SUSPENDED');
  const updated = await write(m, { status: 'SUSPENDED', suspendReason: 'ADMIN', suspendToken: null, lastSuspendedAt: new Date() }, 'status');
  await recordAudit(actor, { action: 'market.suspend', targetType: 'market', targetId: id, reason, before: { status: m.status }, after: { status: 'SUSPENDED' } });
  return toMarketView(updated);
}

/** Lifts an admin suspension; the engine then decides (it may stay suspended for e.g. stale data). */
export async function reopenMarket(actor: AuditActor, id: string, reason: string): Promise<MarketView> {
  const m = await load(id);
  if (m.status !== 'SUSPENDED') throw new AppError('INVALID_STATE', 'Market is not suspended');
  const updated = await write(m, { status: 'OPEN', suspendReason: null, suspendToken: null }, 'status');
  await recordAudit(actor, { action: 'market.reopen', targetType: 'market', targetId: id, reason, before: { status: m.status, reason: m.suspendReason } });
  await reevaluateMatch(m.matchId.toString());
  return toMarketView((await Market.findById(updated._id).lean()) ?? updated);
}

export async function closeMarket(actor: AuditActor, id: string, reason: string): Promise<MarketView> {
  const m = await load(id);
  assertAdminTransition(m.status, 'CLOSED');
  const updated = await write(m, { status: 'CLOSED', suspendReason: null, suspendToken: null, closedAt: new Date() }, 'status');
  await recordAudit(actor, { action: 'market.close', targetType: 'market', targetId: id, reason, before: { status: m.status } });
  return toMarketView(updated);
}
