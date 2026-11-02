import { Types } from 'mongoose';
import { withTransaction } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { publish } from '../../realtime/bus.js';
import { AppError } from '../../utils/errors.js';
import { withLock } from '../../utils/lock.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from '../audit/audit.service.js';
import { Bet, type IBet, type LegResultStatus } from '../bets/bet.model.js';
import { toAdminBetView, toBetView } from '../bets/bet.views.js';
import { settleLegs, type LegResult } from '../bets/math.js';
import { acceptPendingBet } from '../bets/placement.service.js';
import { recordSettlement } from '../leaderboard/leaderboard.service.js';
import { addExposure } from '../markets/liability.js';
import { Market, type IMarket, type ISelection, type MarketResult } from '../markets/market.model.js';
import { toMarketView } from '../markets/market.views.js';
import { BallEventModel, Match } from '../matches/match.model.js';
import { notify, tokens } from '../notifications/notifications.service.js';
import { availableAccount, lockedAccount } from '../wallet/accounts.js';
import { notifyWalletChanged, transferInSession } from '../wallet/ledger.service.js';
import { resolveMarket } from './resolvers.js';

function legOutcome(leg: IBet['legs'][number], market: IMarket | undefined): { result: LegResultStatus; ways: number | null } {
  const r = market?.result;
  if (!r || (market.status !== 'SETTLED' && market.status !== 'VOID')) return { result: 'PENDING', ways: null };
  if (r.isVoid || r.voidSelectionIds.includes(leg.selectionId)) return { result: 'VOID', ways: null };
  if (!r.winningSelectionIds.includes(leg.selectionId)) return { result: 'LOST', ways: null };
  return r.deadHeatWays > 1 ? { result: 'DEAD_HEAT', ways: r.deadHeatWays } : { result: 'WON', ways: null };
}

const headline: Record<string, string> = { WON: 'Bet won', LOST: 'Bet lost', VOID: 'Bet cancelled: tokens returned' };

/**
 * Settles one bet from the current results of its legs' markets. Idempotent: an open bet whose
 * legs aren't all decided just gets its leg results updated; a decided bet is settled once
 * (ledger keys `settle:<betId>:r<round>:*`, plus a version check on the bet).
 */
export async function settleBet(betId: string): Promise<IBet | null> {
  const bet = await Bet.findById(betId).lean();
  if (!bet || bet.status !== 'ACCEPTED') return null;
  const markets = new Map((await Market.find({ _id: { $in: bet.legs.map((l) => l.marketId) } }).lean()).map((m) => [m._id.toString(), m]));
  const legs = bet.legs.map((l) => {
    const o = legOutcome(l, markets.get(l.marketId.toString()));
    return { ...l, result: o.result, deadHeatWays: o.ways };
  });
  const outcome = settleLegs(bet.stake, legs.map((l): LegResult => ({ outcome: l.result, odds: l.odds, ...(l.deadHeatWays ? { deadHeatWays: l.deadHeatWays } : {}) })));

  if (outcome.status === 'PENDING') {
    await Bet.updateOne({ _id: bet._id, version: bet.version }, { $set: { legs }, $inc: { version: 1 } });
    return null;
  }

  const userId = bet.userId.toString();
  const round = bet.settlementRound ?? 0;
  const key = (part: string): string => `settle:${betId}:r${round}:${part}`;
  const ref = { type: 'bet', id: betId };
  const now = new Date();
  const settled = await withTransaction(async (session) => {
    const updated = await Bet.findOneAndUpdate(
      { _id: bet._id, status: 'ACCEPTED', version: bet.version },
      { $set: { status: outcome.status, payout: outcome.payout, settledAt: now, legs }, $inc: { version: 1 } },
      { new: true, lean: true, session },
    );
    if (!updated) return null; // settled concurrently; the other run did the postings
    if (outcome.status === 'VOID') {
      await transferInSession({ from: lockedAccount(userId), to: availableAccount(userId), amount: bet.stake, type: 'BET_REFUND', idempotencyKey: key('refund'), ref }, session);
    } else {
      await transferInSession({ from: lockedAccount(userId), to: 'house', amount: bet.stake, type: 'BET_STAKE_CAPTURE', idempotencyKey: key('capture'), ref }, session);
      if (outcome.payout > 0) {
        await transferInSession({ from: 'house', to: availableAccount(userId), amount: outcome.payout, type: 'BET_PAYOUT', idempotencyKey: key('payout'), ref }, session);
      }
    }
    return updated;
  });
  if (!settled) return null;

  for (const leg of bet.legs) await addExposure(leg.marketId.toString(), leg.selectionId, bet.stake, bet.potentialReturn, -1);
  if (settled.status !== 'VOID') await recordSettlement(userId, settled.stake, settled.payout, now);
  await notifyWalletChanged([userId], 'BET_SETTLED');
  await publish('bet.updated', { userId, bet: toBetView(settled) });
  await publish('admin.bet', { event: 'settled', bet: toAdminBetView(settled) });
  const first = settled.legs[0];
  await notify({
    userId,
    type: 'BET_SETTLED',
    title: headline[settled.status] ?? 'Bet settled',
    body: `${settled.kind === 'ACCA' ? `Combo of ${settled.legs.length} picks` : `${first?.selectionName ?? ''} (${first?.marketName ?? ''})`}: ${settled.status === 'LOST' ? `you bet ${tokens(settled.stake)}` : `you got ${tokens(settled.payout)}`}`,
    data: { betId, status: settled.status, payout: settled.payout },
    dedupeKey: `settled:${betId}:r${round}`,
  });
  return settled;
}

function selectionStatuses(selections: ISelection[], r: MarketResult): ISelection[] {
  return selections.map((s) => ({
    ...s,
    status: r.isVoid || r.voidSelectionIds.includes(s.id) ? 'VOID' : r.winningSelectionIds.includes(s.id) ? (r.deadHeatWays > 1 ? 'DEAD_HEAT' : 'WINNER') : 'LOSER',
  }));
}

/** Settles every open bet that includes this market (each in its own transaction). */
export async function settleBetsForMarket(marketId: Types.ObjectId): Promise<number> {
  let n = 0;
  for (const b of await Bet.find({ 'legs.marketId': marketId, status: { $in: ['ACCEPTED', 'PENDING_DELAY'] } }).select('_id status').lean()) {
    try {
      // A bet still in its delay when the market closed can't be accepted any more: reject + refund.
      if (b.status === 'PENDING_DELAY') await acceptPendingBet(b._id.toString());
      else if (await settleBet(b._id.toString())) n += 1;
    } catch (err) {
      logger.error({ err, betId: b._id.toString() }, 'bet settlement failed; catch-up will retry');
    }
  }
  return n;
}

/**
 * Records a market's result and settles its bets. Locked per market and idempotent: a repeat call
 * on an already-settled market only finishes any bets a previous run didn't get to.
 */
export async function settleMarket(marketId: string, result: MarketResult, actor: AuditActor = SYSTEM_ACTOR, reason: string | null = null): Promise<IMarket> {
  return withLock(
    `settle:market:${marketId}`,
    60_000,
    async () => {
      const m = await Market.findById(marketId).lean();
      if (!m) throw AppError.notFound('Market');
      if (m.status === 'SETTLED' || m.status === 'VOID') {
        await settleBetsForMarket(m._id);
        return m;
      }
      const now = new Date();
      const status = result.isVoid ? 'VOID' : 'SETTLED';
      const updated = await Market.findOneAndUpdate(
        { _id: m._id, version: m.version, status: { $in: ['PENDING', 'OPEN', 'SUSPENDED', 'CLOSED'] } },
        { $set: { status, result, selections: selectionStatuses(m.selections, result), settledAt: now, closedAt: m.closedAt ?? now, suspendReason: null, suspendToken: null }, $inc: { version: 1 } },
        { new: true, lean: true },
      );
      if (!updated) throw new AppError('CONFLICT', 'Market changed during settlement; retry');
      await recordAudit(actor, { action: result.isVoid ? 'market.void' : 'market.settle', targetType: 'market', targetId: marketId, reason: reason ?? result.reason, before: { status: m.status }, after: { status, result } });
      await publish('market.updated', { matchId: m.matchId.toString(), kind: 'status', market: toMarketView(updated) });
      await settleBetsForMarket(updated._id);
      return updated;
    },
    () => {
      throw new AppError('CONFLICT', 'This market is being settled right now');
    },
  );
}

/** Settles every closed, decided market of a match. Undecidable ones wait (or go to manual review). */
export async function autoSettleMatch(matchId: string): Promise<{ settled: number; waiting: number }> {
  if (!Types.ObjectId.isValid(matchId)) return { settled: 0, waiting: 0 };
  const match = await Match.findById(matchId).lean();
  if (!match) return { settled: 0, waiting: 0 };
  const markets = await Market.find({ matchId: match._id, status: 'CLOSED', result: null, type: { $ne: 'CUSTOM' } }).lean();
  if (markets.length === 0) return { settled: 0, waiting: 0 };
  const balls = (await BallEventModel.find({ matchId: match._id }).sort({ innings: 1, seq: 1 }).lean()) as unknown as Parameters<typeof resolveMarket>[2];
  let settled = 0;
  let waiting = 0;
  for (const m of markets) {
    const r = resolveMarket(m, match, balls);
    if (!r) {
      waiting += 1;
      continue;
    }
    try {
      await settleMarket(m._id.toString(), r);
      settled += 1;
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'CONFLICT')) logger.error({ err, marketId: m._id.toString() }, 'auto-settlement failed');
    }
  }
  return { settled, waiting };
}

/** Backstop: settle bets left open on already-settled markets, and closed markets nobody settled yet. */
export async function settlementCatchUp(): Promise<{ bets: number; matches: number }> {
  const done = await Market.find({ status: { $in: ['SETTLED', 'VOID'] }, settledAt: { $gte: new Date(Date.now() - 7 * 86_400_000) } }).select('_id').lean();
  const stuck = await Bet.find({ status: 'ACCEPTED', 'legs.marketId': { $in: done.map((m) => m._id) } }).select('_id').limit(500).lean();
  let bets = 0;
  for (const b of stuck) if (await settleBet(b._id.toString())) bets += 1;
  const matchIds = await Market.distinct('matchId', { status: 'CLOSED', result: null, type: { $ne: 'CUSTOM' } });
  for (const id of matchIds) await autoSettleMatch(String(id));
  return { bets, matches: matchIds.length };
}

export interface ManualSettleInput {
  winningSelectionIds?: string[];
  void?: boolean;
  settledValue?: number | null;
  reason: string;
}

/** Admin settles (or voids) a market by hand: custom markets, unclear results, corrections before settlement. */
export async function manualSettle(actor: AuditActor, marketId: string, input: ManualSettleInput): Promise<IMarket> {
  if (!Types.ObjectId.isValid(marketId)) throw AppError.notFound('Market');
  const m = await Market.findById(marketId).lean();
  if (!m) throw AppError.notFound('Market');
  if (m.status === 'SETTLED' || m.status === 'VOID') throw new AppError('INVALID_STATE', 'Market is already settled; use resettle to change the result');
  const result = buildManualResult(m, input);
  return settleMarket(marketId, result, actor, input.reason);
}

export function buildManualResult(m: Pick<IMarket, 'selections'>, input: ManualSettleInput): MarketResult {
  if (input.void) return { winningSelectionIds: [], deadHeatWays: 1, isVoid: true, reason: input.reason, settledValue: null, voidSelectionIds: [] };
  const ids = input.winningSelectionIds ?? [];
  if (ids.length === 0) throw AppError.badRequest('Pick at least one winning selection, or void the market');
  const known = new Set(m.selections.map((s) => s.id));
  for (const id of ids) if (!known.has(id)) throw AppError.badRequest(`Unknown selection ${id}`);
  return { winningSelectionIds: ids, deadHeatWays: ids.length, isVoid: false, reason: input.reason, settledValue: input.settledValue ?? null, voidSelectionIds: [] };
}
