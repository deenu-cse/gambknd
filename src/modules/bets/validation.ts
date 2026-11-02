import { Types } from 'mongoose';
import { AppError } from '../../utils/errors.js';
import { getBook } from '../markets/liability.js';
import { Market, type IMarket, type ISelection } from '../markets/market.model.js';
import { Match, type IMatch } from '../matches/match.model.js';
import type { PlatformSettings } from '../settings/settings.service.js';
import { applyDuePendingIncrease } from '../users/responsiblePlay.js';
import type { ResponsiblePlay } from '../users/user.model.js';
import { Bet, OPEN_BET_STATUSES, SETTLED_BET_STATUSES } from './bet.model.js';
import { MAX_ACCA_LEGS } from './math.js';

export interface LegRequest {
  marketId: string;
  selectionId: string;
  odds: number;
}

export interface ResolvedLeg {
  market: IMarket;
  selection: ISelection;
  match: Pick<IMatch, '_id' | 'title' | 'bettingEnabled' | 'status'>;
  requestedOdds: number;
  /** Odds the bet will be struck at. */
  odds: number;
}

/** Why a market can't take a bet right now, as a typed error. */
export function marketBlock(m: IMarket, match: Pick<IMatch, 'bettingEnabled'> | undefined): AppError | null {
  if (!match?.bettingEnabled) return new AppError('MARKET_SUSPENDED', 'Betting is paused for this match', { marketId: m._id.toString(), reason: 'BETTING_DISABLED' });
  if (m.status === 'SUSPENDED' || m.status === 'PENDING') return new AppError('MARKET_SUSPENDED', 'Market is suspended', { marketId: m._id.toString(), reason: m.suspendReason });
  if (m.status !== 'OPEN') return new AppError('MARKET_CLOSED', 'Market is closed', { marketId: m._id.toString() });
  return null;
}

/**
 * Loads and checks every leg. Odds rule: same price → fine; better for the user → taken at the
 * new price only if they accept better odds; worse → ODDS_CHANGED with the new prices.
 */
export async function resolveLegs(legs: readonly LegRequest[], acceptBetterOdds: boolean): Promise<ResolvedLeg[]> {
  if (legs.length < 1 || legs.length > MAX_ACCA_LEGS) throw AppError.badRequest(`A bet has 1–${MAX_ACCA_LEGS} selections`);
  if (new Set(legs.map((l) => l.marketId)).size !== legs.length) throw AppError.badRequest('Each market can appear only once in a bet');
  const ids = legs.map((l) => {
    if (!Types.ObjectId.isValid(l.marketId)) throw AppError.notFound('Market');
    return new Types.ObjectId(l.marketId);
  });
  const markets = new Map((await Market.find({ _id: { $in: ids } }).lean()).map((m) => [m._id.toString(), m]));
  const matchIds = [...new Set([...markets.values()].map((m) => m.matchId.toString()))];
  const matches = new Map((await Match.find({ _id: { $in: matchIds } }).select('_id title bettingEnabled status').lean()).map((m) => [m._id.toString(), m]));

  const changed: Array<{ marketId: string; selectionId: string; requested: number; current: number }> = [];
  const resolved = legs.map((l) => {
    const market = markets.get(l.marketId);
    if (!market) throw AppError.notFound('Market');
    const match = matches.get(market.matchId.toString());
    const block = marketBlock(market, match);
    if (block) throw block;
    const selection = market.selections.find((s) => s.id === l.selectionId);
    if (!selection || selection.status !== 'ACTIVE') throw new AppError('SELECTION_INACTIVE', 'That selection is not available', { marketId: l.marketId, selectionId: l.selectionId });
    let odds = l.odds;
    if (selection.odds < l.odds || (selection.odds > l.odds && !acceptBetterOdds)) {
      changed.push({ marketId: l.marketId, selectionId: l.selectionId, requested: l.odds, current: selection.odds });
    } else if (selection.odds > l.odds) {
      odds = selection.odds;
    }
    return { market, selection, match: match!, requestedOdds: l.odds, odds };
  });
  if (changed.length > 0) throw new AppError('ODDS_CHANGED', 'Odds have changed. Review the new prices and place again.', { legs: changed });

  if (resolved.length > 1 && new Set(resolved.map((r) => r.market.matchId.toString())).size !== resolved.length) {
    // Same-match legs are correlated (e.g. winner + innings total); accumulators must span matches.
    throw AppError.badRequest('Accumulator selections must be from different matches');
  }
  return resolved;
}

export function stakeBounds(legs: readonly ResolvedLeg[], settings: PlatformSettings): { min: number; max: number } {
  return {
    min: Math.max(settings.globalMinStake, ...legs.map((l) => l.market.minStake)),
    max: Math.min(settings.globalMaxStake, ...legs.map((l) => l.market.maxStake)),
  };
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The user's own limits (Profile → Responsible play), applied before any money moves.
 * Daily stake limit: today's stakes (excluding rejected) + this one.
 * Daily loss limit: today's settled net loss + today's open stakes + this one (worst case).
 */
export async function checkResponsiblePlay(userId: string, rp: ResponsiblePlay, stake: number): Promise<void> {
  const limits = { ...rp };
  applyDuePendingIncrease(limits);
  if (limits.dailyStakeLimit === null && limits.dailyLossLimit === null) return;
  const since = startOfUtcDay();
  const uid = new Types.ObjectId(userId);
  const [placed] = await Bet.aggregate<{ total: number; open: number }>([
    { $match: { userId: uid, placedAt: { $gte: since }, status: { $ne: 'REJECTED' } } },
    { $group: { _id: null, total: { $sum: '$stake' }, open: { $sum: { $cond: [{ $in: ['$status', OPEN_BET_STATUSES] }, '$stake', 0] } } } },
  ]);
  if (limits.dailyStakeLimit !== null && (placed?.total ?? 0) + stake > limits.dailyStakeLimit) {
    throw new AppError('RESPONSIBLE_PLAY_LIMIT', 'This bet would go over your daily stake limit', { limit: limits.dailyStakeLimit, used: placed?.total ?? 0 });
  }
  if (limits.dailyLossLimit !== null) {
    const [settled] = await Bet.aggregate<{ net: number }>([
      { $match: { userId: uid, settledAt: { $gte: since }, status: { $in: SETTLED_BET_STATUSES } } },
      { $group: { _id: null, net: { $sum: { $subtract: ['$stake', '$payout'] } } } },
    ]);
    const worstCase = (settled?.net ?? 0) + (placed?.open ?? 0) + stake;
    if (worstCase > limits.dailyLossLimit) {
      throw new AppError('RESPONSIBLE_PLAY_LIMIT', 'This bet could take you past your daily loss limit', { limit: limits.dailyLossLimit, atRisk: worstCase - stake });
    }
  }
}

/** Worst-case house loss per leg market must stay within its maxLiability (accas count in full on every leg). */
export async function checkLiability(legs: readonly ResolvedLeg[], stake: number, potentialReturn: number): Promise<void> {
  for (const l of legs) {
    const book = await getBook(l.market._id.toString(), l.market.selections.map((s) => s.id));
    const current = book.worstCaseLoss[l.selection.id] ?? 0;
    // Accepting this bet adds its return to this selection and its stake to the pot.
    if (current + potentialReturn - stake > l.market.maxLiability) {
      throw new AppError('LIABILITY_LIMIT', 'This bet is too large for the market right now; try a smaller stake', { marketId: l.market._id.toString() });
    }
  }
}
