import { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { publish } from '../../realtime/bus.js';
import { cacheLiveView } from '../matches/matchCache.js';
import type { MatchChange } from '../matches/matchEvents.js';
import { Match, type IBallEvent, type IMatch } from '../matches/match.model.js';
import { toLiveView } from '../matches/match.views.js';
import { ensureSquads } from '../matches/players.service.js';
import { getSettings, type PlatformSettings } from '../settings/settings.service.js';
import { evaluateMarket, type EvalInput } from './evaluate.js';
import { getBooks } from './liability.js';
import { Market, type IMarket } from './market.model.js';
import { toMarketView } from './market.views.js';
import { normalizeBps } from './odds/margin.js';
import { buildContext, type PricingContext } from './pricing/context.js';
import { matchWinnerProbs } from './pricing/matchWinner.js';
import { DEFINITIONS } from './pricing/registry.js';
import { ACTIVE_STATUSES } from './stateMachine.js';
import type { MarketSpec } from './types.js';

export type ReopenScheduler = (matchId: string, token: string, delayMs: number) => Promise<void>;

let scheduleReopen: ReopenScheduler = () => Promise.resolve();

/** The worker installs a BullMQ-backed scheduler; tests install their own. */
export function setReopenScheduler(fn: ReopenScheduler): void {
  scheduleReopen = fn;
}

function ballInput(balls: readonly IBallEvent[]): EvalInput['ball'] {
  const last = balls.at(-1);
  if (!last) return null;
  const reason = balls.some((b) => b.wicket) ? 'WICKET' : balls.some((b) => b.isBoundary) ? 'BOUNDARY' : 'BALL';
  return { reason, token: last._id.toString() };
}

async function createMissing(match: IMatch, ctx: PricingContext, settings: PlatformSettings): Promise<number> {
  const enabled = new Set(settings.marketTypesEnabled);
  const specs: MarketSpec[] = DEFINITIONS.flatMap((d) => d.specs(ctx)).filter((s) => enabled.has(s.type));
  if (specs.length === 0) return 0;
  const existing = new Set((await Market.find({ matchId: match._id, key: { $in: specs.map((s) => s.key) } }).select('key').lean()).map((m) => m.key));
  const fresh = specs.filter((s) => !existing.has(s.key));
  if (fresh.length === 0) return 0;
  const docs = fresh.map((s) => ({
    matchId: match._id,
    key: s.key,
    type: s.type,
    group: s.group,
    name: s.name,
    params: s.params,
    // Placeholder prices; the evaluation pass below prices them before anyone can see them OPEN.
    selections: s.selections.map((sel) => ({ id: sel.id, name: sel.name, teamKey: sel.teamKey ?? null, playerId: sel.playerId ?? null, odds: 200, probabilityBps: 0, status: 'ACTIVE' })),
    status: 'PENDING',
    inPlay: s.inPlay,
    autoManaged: true,
    marginBps: settings.defaultMarginsBps[s.type] ?? 500,
    betDelayMs: s.inPlay ? settings.defaultBetDelayMs : 0,
    minStake: settings.globalMinStake,
    maxStake: settings.globalMaxStake,
    maxLiability: settings.defaultMaxLiability,
    lineX10: s.lineX10,
    sortOrder: s.sortOrder,
  }));
  try {
    await Market.insertMany(docs, { ordered: false });
  } catch (err) {
    // Another evaluation created some of these first; the unique (matchId, key) index kept one each.
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  return fresh.length;
}

async function persist(m: IMarket, patch: NonNullable<ReturnType<typeof evaluateMarket>>, created: boolean): Promise<boolean> {
  const updated = await Market.findOneAndUpdate(
    { _id: m._id, version: m.version },
    {
      $set: {
        status: patch.status,
        suspendReason: patch.suspendReason,
        suspendToken: patch.suspendToken,
        selections: patch.selections,
        lastPricedAt: patch.lastPricedAt,
        ...(patch.closedAt ? { closedAt: patch.closedAt } : {}),
        ...(patch.status === 'SUSPENDED' && m.status !== 'SUSPENDED' ? { lastSuspendedAt: new Date() } : {}),
      },
      $inc: { version: 1 },
    },
    { new: true, lean: true },
  );
  if (!updated) return false; // someone else changed it; their write wins, the next pass catches up
  const kind = created ? 'created' : patch.kind;
  if (kind) await publish('market.updated', { matchId: m.matchId.toString(), kind, market: toMarketView(updated) });
  return true;
}

async function updateWinProbability(match: IMatch, ctx: PricingContext): Promise<void> {
  if (!match.currentState) return;
  const probs = matchWinnerProbs(ctx);
  const bps = probs ? (normalizeBps(probs)[match.teams[0].key] ?? null) : null;
  if (bps === match.currentState.winProbabilityBps) return;
  const doc = await Match.findOneAndUpdate({ _id: match._id }, { $set: { 'currentState.winProbabilityBps': bps } }, { new: true, lean: true });
  if (!doc) return;
  const view = toLiveView(doc);
  await cacheLiveView(view);
  await publish('match.updated', { matchId: doc._id.toString(), view });
}

export interface EngineRun {
  created: number;
  updated: number;
  suspendedForBall: boolean;
}

/** Re-evaluates every active market of a match. `balls` = deliveries new since the last pass. */
export async function evaluateMatch(input: IMatch, opts: { balls?: readonly IBallEvent[]; reopenToken?: string | null } = {}): Promise<EngineRun> {
  const settings = await getSettings();
  let match = input;
  // Player markets need squads; fetch them once, pre-match (one budgeted provider call in live mode).
  if ((match.status === 'UPCOMING' || match.status === 'TOSS') && match.squads.length === 0 && !match.squadsSyncedAt && match.capabilities.squads) {
    try {
      await ensureSquads(match._id.toString());
      match = (await Match.findById(match._id).lean()) ?? match;
    } catch (err) {
      logger.warn({ err, matchId: match._id.toString() }, 'squads unavailable; player markets skipped');
    }
  }
  const ctx = await buildContext(match);
  const created = await createMissing(match, ctx, settings);
  const markets = await Market.find({ matchId: match._id, status: { $in: ACTIVE_STATUSES } }).lean();
  const books = await getBooks(markets.map((m) => ({ id: m._id.toString(), selectionIds: m.selections.map((s) => s.id) })));
  const ball = ballInput(opts.balls ?? []);

  let updated = 0;
  for (const m of markets) {
    const patch = evaluateMarket(m, ctx, { ball, reopenToken: opts.reopenToken ?? null, book: books.get(m._id.toString()) ?? null, settings });
    if (patch && (await persist(m, patch, m.status === 'PENDING'))) updated += 1;
  }
  if (ball) {
    const delay = settings.marketReopenDelayMs * (ball.reason === 'WICKET' ? 1.5 : 1);
    await scheduleReopen(match._id.toString(), ball.token, Math.round(delay));
  }
  await updateWinProbability(match, ctx);
  return { created, updated, suspendedForBall: ball !== null };
}

/** MatchChange handler, registered in the worker. */
export async function onMatchChange(change: MatchChange): Promise<void> {
  await evaluateMatch(change.match, { balls: change.newBalls });
}

/** Lifts the ball suspension for one delivery once its safety window has passed. */
export async function reopenAfterBall(matchId: string, token: string): Promise<EngineRun | null> {
  if (!Types.ObjectId.isValid(matchId)) return null;
  const match = await Match.findById(matchId).lean();
  if (!match) return null;
  return evaluateMatch(match, { reopenToken: token });
}

/** Admin toggles, settings changes, bet-driven liability changes: re-run without a ball. */
export async function reevaluateMatch(matchId: string): Promise<EngineRun | null> {
  if (!Types.ObjectId.isValid(matchId)) return null;
  const match = await Match.findById(matchId).lean();
  if (!match) return null;
  try {
    return await evaluateMatch(match);
  } catch (err) {
    logger.error({ err, matchId }, 'market re-evaluation failed');
    throw err;
  }
}
