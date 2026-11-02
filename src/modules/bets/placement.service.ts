import { Types } from 'mongoose';
import { withTransaction } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { publish } from '../../realtime/bus.js';
import { AppError } from '../../utils/errors.js';
import { reevaluateMatch } from '../markets/engine.js';
import { addExposure, getBook } from '../markets/liability.js';
import { Market } from '../markets/market.model.js';
import { Match } from '../matches/match.model.js';
import { IN_PROGRESS_STATUSES } from '../../providers/cricket/types.js';
import { getSettings } from '../settings/settings.service.js';
import { playBlock } from '../users/responsiblePlay.js';
import { User } from '../users/user.model.js';
import { availableAccount, lockedAccount } from '../wallet/accounts.js';
import { notifyWalletChanged, transferInSession } from '../wallet/ledger.service.js';
import { Bet, type IBet } from './bet.model.js';
import { notify, tokens } from '../notifications/notifications.service.js';
import { toAdminBetView, toBetView, type BetView } from './bet.views.js';
import { comboOdds, potentialReturn } from './math.js';
import { checkLiability, checkResponsiblePlay, marketBlock, resolveLegs, stakeBounds, type LegRequest } from './validation.js';

export interface PlaceBetInput {
  legs: LegRequest[];
  stake: number;
  idempotencyKey: string;
  /** Overrides the profile preference for this bet. */
  acceptBetterOdds?: boolean;
}

export interface ClientCtx {
  userId: string;
  ip: string | null;
  userAgent: string | null;
}

export type AcceptanceScheduler = (betId: string, delayMs: number) => Promise<void>;
let scheduleAcceptance: AcceptanceScheduler = () => Promise.resolve();
export function setAcceptanceScheduler(fn: AcceptanceScheduler): void {
  scheduleAcceptance = fn;
}

function sameRequest(bet: IBet, input: PlaceBetInput): boolean {
  return (
    bet.stake === input.stake &&
    bet.legs.length === input.legs.length &&
    bet.legs.every((l, i) => l.marketId.toString() === input.legs[i]?.marketId && l.selectionId === input.legs[i]?.selectionId)
  );
}

async function announce(bet: IBet, event: 'placed' | 'accepted' | 'rejected' | 'cashed_out' | 'voided'): Promise<void> {
  await publish('bet.updated', { userId: bet.userId.toString(), bet: toBetView(bet) });
  await publish('admin.bet', { event, bet: toAdminBetView(bet) });
}

/** Adds an accepted bet to each leg market's book, and reprices if it pushed a book into shading. */
async function addToBooks(bet: IBet): Promise<void> {
  const settings = await getSettings();
  const toReprice = new Set<string>();
  for (const leg of bet.legs) {
    const marketId = leg.marketId.toString();
    await addExposure(marketId, leg.selectionId, bet.stake, bet.potentialReturn);
    const market = await Market.findById(leg.marketId).select('selections maxLiability matchId').lean();
    if (!market) continue;
    const book = await getBook(marketId, market.selections.map((s) => s.id));
    await publish('admin.liability', { matchId: leg.matchId.toString(), marketId, book });
    const worst = Math.max(...Object.values(book.worstCaseLoss));
    if (worst > (market.maxLiability * settings.shadingStartBps) / 10_000) toReprice.add(market.matchId.toString());
  }
  for (const matchId of toReprice) await reevaluateMatch(matchId);
}

/**
 * POST /api/bets. Every check happens before money moves; the stake moves available → locked
 * in the same transaction that creates the bet. In-play bets wait `betDelayMs` and are then
 * re-checked by `acceptPendingBet`; pre-match bets are accepted instantly.
 */
export async function placeBet(ctx: ClientCtx, input: PlaceBetInput): Promise<{ bet: BetView; duplicate: boolean }> {
  const uid = new Types.ObjectId(ctx.userId);
  const existing = await Bet.findOne({ userId: uid, idempotencyKey: input.idempotencyKey }).lean();
  if (existing) {
    if (!sameRequest(existing, input)) throw new AppError('DUPLICATE_REQUEST', 'This idempotency key was already used for a different bet');
    return { bet: toBetView(existing), duplicate: true };
  }

  const settings = await getSettings();
  if (settings.maintenance.enabled) throw new AppError('MAINTENANCE_MODE', settings.maintenance.message || 'Betting is paused for maintenance');
  const user = await User.findById(uid).select('status responsiblePlay preferences').lean();
  if (!user) throw AppError.unauthenticated();
  const block = playBlock(user.status, user.responsiblePlay);
  if (block) throw new AppError(block.code, 'Betting is not available on this account right now', { until: block.until });

  const legs = await resolveLegs(input.legs, input.acceptBetterOdds ?? user.preferences.acceptBetterOdds);
  const bounds = stakeBounds(legs, settings);
  if (input.stake < bounds.min || input.stake > bounds.max) throw new AppError('STAKE_LIMIT', 'Stake is outside the allowed range', bounds);
  const odds = comboOdds(legs.map((l) => l.odds));
  const ret = potentialReturn(input.stake, odds);
  await checkResponsiblePlay(ctx.userId, user.responsiblePlay, input.stake);
  await checkLiability(legs, input.stake, ret);

  // The delay protects against past-posting while play is live; pre-match bets are instant
  // even on markets (like Match Winner) that will also trade in-play.
  const live = (l: (typeof legs)[number]): boolean => l.market.inPlay && IN_PROGRESS_STATUSES.includes(l.match.status);
  const delayMs = Math.max(0, ...legs.filter(live).map((l) => l.market.betDelayMs));
  const now = new Date();
  const betId = new Types.ObjectId();
  let bet: IBet;
  try {
    bet = await withTransaction(async (session) => {
      const [doc] = await Bet.create(
        [
          {
            _id: betId,
            userId: uid,
            kind: legs.length > 1 ? 'ACCA' : 'SINGLE',
            legs: legs.map((l) => ({
              matchId: l.market.matchId,
              marketId: l.market._id,
              selectionId: l.selection.id,
              marketType: l.market.type,
              marketName: l.market.name,
              selectionName: l.selection.name,
              matchTitle: l.match.title,
              lineX10: l.market.lineX10,
              odds: l.odds,
              requestedOdds: l.requestedOdds,
              marketVersion: l.market.version,
              inPlay: live(l),
            })),
            stake: input.stake,
            odds,
            potentialReturn: ret,
            status: delayMs > 0 ? 'PENDING_DELAY' : 'ACCEPTED',
            idempotencyKey: input.idempotencyKey,
            placedAt: now,
            acceptAt: delayMs > 0 ? new Date(now.getTime() + delayMs) : null,
            acceptedAt: delayMs > 0 ? null : now,
            ip: ctx.ip,
            userAgent: ctx.userAgent?.slice(0, 300) ?? null,
          },
        ],
        { session },
      );
      await transferInSession(
        { from: availableAccount(ctx.userId), to: lockedAccount(ctx.userId), amount: input.stake, type: 'BET_STAKE', idempotencyKey: `stake:${betId.toString()}`, ref: { type: 'bet', id: betId.toString() } },
        session,
      );
      return (doc as NonNullable<typeof doc>).toObject();
    });
  } catch (err) {
    // A concurrent request with the same key won the race: return its bet.
    if ((err as { code?: number }).code === 11000) {
      const winner = await Bet.findOne({ userId: uid, idempotencyKey: input.idempotencyKey }).lean();
      if (winner) return { bet: toBetView(winner), duplicate: true };
    }
    throw err;
  }

  await notifyWalletChanged([ctx.userId], 'BET_STAKE');
  await announce(bet, 'placed');
  if (bet.status === 'ACCEPTED') await addToBooks(bet);
  else await scheduleAcceptance(bet._id.toString(), delayMs);
  return { bet: toBetView(bet), duplicate: false };
}

/** Why a delayed bet can't be accepted now, or null if it can. */
async function delayedRejection(bet: IBet): Promise<{ reason: string; odds: number[] } | null> {
  const odds: number[] = [];
  for (const leg of bet.legs) {
    const market = await Market.findById(leg.marketId).lean();
    if (!market) return { reason: 'MARKET_CLOSED', odds };
    const match = await Match.findById(market.matchId).select('bettingEnabled').lean();
    const block = marketBlock(market, match ?? undefined);
    if (block) return { reason: block.code, odds };
    // Anything that suspended the market during the delay (a delivery, a review…) voids the price.
    if (leg.inPlay && market.lastSuspendedAt && market.lastSuspendedAt > bet.placedAt) return { reason: 'MARKET_SUSPENDED', odds };
    const sel = market.selections.find((s) => s.id === leg.selectionId);
    if (!sel || sel.status !== 'ACTIVE') return { reason: 'SELECTION_INACTIVE', odds };
    if (sel.odds < leg.odds) return { reason: 'ODDS_CHANGED', odds };
    odds.push(leg.odds);
  }
  return null;
}

/** Runs when an in-play bet's delay ends (BullMQ delayed job, or the sweeper as a backstop). */
export async function acceptPendingBet(betId: string): Promise<IBet | null> {
  const bet = await Bet.findById(betId).lean();
  if (!bet || bet.status !== 'PENDING_DELAY') return null;
  const rejection = await delayedRejection(bet);
  const userId = bet.userId.toString();
  const result = await withTransaction(async (session) => {
    if (!rejection) {
      return Bet.findOneAndUpdate({ _id: bet._id, status: 'PENDING_DELAY' }, { $set: { status: 'ACCEPTED', acceptedAt: new Date() }, $inc: { version: 1 } }, { new: true, lean: true, session });
    }
    const updated = await Bet.findOneAndUpdate(
      { _id: bet._id, status: 'PENDING_DELAY' },
      { $set: { status: 'REJECTED', rejectReason: rejection.reason, settledAt: new Date() }, $inc: { version: 1 } },
      { new: true, lean: true, session },
    );
    if (!updated) return null;
    await transferInSession(
      { from: lockedAccount(userId), to: availableAccount(userId), amount: bet.stake, type: 'BET_REFUND', idempotencyKey: `refund:${betId}`, ref: { type: 'bet', id: betId }, meta: { reason: rejection.reason } },
      session,
    );
    return updated;
  });
  if (!result) return null;
  if (result.status === 'ACCEPTED') {
    await addToBooks(result);
    await announce(result, 'accepted');
  } else {
    await notifyWalletChanged([userId], 'BET_REFUND');
    await announce(result, 'rejected');
    await notify({
      userId,
      type: 'BET_REJECTED',
      title: 'Bet not accepted',
      body: `Things changed while we were confirming your bet (${rejection?.reason ?? 'changed'}). Your ${tokens(result.stake)} are back in your wallet.`,
      data: { betId, reason: rejection?.reason ?? null },
      dedupeKey: `rejected:${betId}`,
    });
  }
  return result;
}

/** Backstop if a delayed job was lost: process delayed bets that are well past due. */
export async function sweepPendingBets(graceMs = 5_000): Promise<number> {
  const due = await Bet.find({ status: 'PENDING_DELAY', acceptAt: { $lt: new Date(Date.now() - graceMs) } }).select('_id').limit(200).lean();
  for (const b of due) {
    try {
      await acceptPendingBet(b._id.toString());
    } catch (err) {
      logger.error({ err, betId: b._id.toString() }, 'pending bet sweep failed');
    }
  }
  return due.length;
}

export { announce };
