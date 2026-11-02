import { Types } from 'mongoose';
import { withTransaction } from '../../config/db.js';
import { AppError } from '../../utils/errors.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { addExposure } from '../markets/liability.js';
import { availableAccount, lockedAccount } from '../wallet/accounts.js';
import { notifyWalletChanged, transferInSession } from '../wallet/ledger.service.js';
import { Bet, OPEN_BET_STATUSES, SETTLED_BET_STATUSES, type BetStatus, type IBet } from './bet.model.js';
import { toAdminBetView, toBetView, type AdminBetView, type BetView } from './bet.views.js';
import { announce } from './placement.service.js';
import { notify, tokens } from '../notifications/notifications.service.js';
import { User } from '../users/user.model.js';

export type BetBucket = 'open' | 'settled' | 'all';

const BUCKETS: Record<BetBucket, readonly BetStatus[] | null> = {
  open: OPEN_BET_STATUSES,
  settled: [...SETTLED_BET_STATUSES, 'REJECTED'],
  all: null,
};

export async function listUserBets(userId: string, q: { bucket: BetBucket; cursor?: string; limit: number; matchId?: string }): Promise<{ items: BetView[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
  const statuses = BUCKETS[q.bucket];
  if (statuses) filter.status = { $in: statuses };
  if (q.matchId) filter['legs.matchId'] = new Types.ObjectId(q.matchId);
  if (q.cursor) filter._id = { $lt: new Types.ObjectId(q.cursor) };
  const rows = await Bet.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  return { items: page.map(toBetView), nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null };
}

export async function getUserBet(userId: string, betId: string): Promise<BetView> {
  if (!Types.ObjectId.isValid(betId)) throw AppError.notFound('Bet');
  const bet = await Bet.findOne({ _id: betId, userId: new Types.ObjectId(userId) }).lean();
  if (!bet) throw AppError.notFound('Bet');
  return toBetView(bet);
}

export interface AdminBetQuery {
  status?: BetStatus;
  userId?: string;
  matchId?: string;
  marketId?: string;
  minStake?: number;
  cursor?: string;
  limit: number;
}

export async function adminListBets(q: AdminBetQuery): Promise<{ items: AdminBetView[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.userId) filter.userId = new Types.ObjectId(q.userId);
  if (q.matchId) filter['legs.matchId'] = new Types.ObjectId(q.matchId);
  if (q.marketId) filter['legs.marketId'] = new Types.ObjectId(q.marketId);
  if (q.minStake) filter.stake = { $gte: q.minStake };
  if (q.cursor) filter._id = { $lt: new Types.ObjectId(q.cursor) };
  const rows = await Bet.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  const users = await User.find({ _id: { $in: page.map((b) => b.userId) } }).select('name email').lean();
  const byId = new Map(users.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));
  return { items: page.map((b) => ({ ...toAdminBetView(b), user: byId.get(b.userId.toString()) ?? null })), nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null };
}

/**
 * Admin voids an OPEN bet: stake back from locked to available, exposure removed, audited.
 * Settled bets are corrected through resettlement (Phase 6), never here.
 */
export async function adminVoidOpenBet(actor: AuditActor, betId: string, reason: string): Promise<AdminBetView> {
  if (!Types.ObjectId.isValid(betId)) throw AppError.notFound('Bet');
  const before = await Bet.findById(betId).lean();
  if (!before) throw AppError.notFound('Bet');
  if (!OPEN_BET_STATUSES.includes(before.status)) throw new AppError('INVALID_STATE', 'Only open bets can be voided here; use resettlement for settled bets');
  const userId = before.userId.toString();
  const voided: IBet = await withTransaction(async (session) => {
    const updated = await Bet.findOneAndUpdate(
      { _id: before._id, status: before.status },
      { $set: { status: 'VOID', voidReason: reason, settledAt: new Date(), payout: before.stake, 'legs.$[].result': 'VOID' }, $inc: { version: 1 } },
      { new: true, lean: true, session },
    );
    if (!updated) throw new AppError('CONFLICT', 'Bet changed while voiding; retry');
    await transferInSession(
      { from: lockedAccount(userId), to: availableAccount(userId), amount: before.stake, type: 'BET_REFUND', idempotencyKey: `void:${betId}`, ref: { type: 'bet', id: betId }, meta: { reason, actorId: actor.id } },
      session,
    );
    await recordAudit(actor, { action: 'bet.void', targetType: 'bet', targetId: betId, reason, before: { status: before.status, stake: before.stake }, after: { status: 'VOID' } }, session);
    return updated;
  });
  if (before.status === 'ACCEPTED') {
    for (const leg of before.legs) await addExposure(leg.marketId.toString(), leg.selectionId, before.stake, before.potentialReturn, -1);
  }
  await notifyWalletChanged([userId], 'BET_REFUND');
  await announce(voided, 'voided');
  await notify({ userId, type: 'BET_VOIDED', title: 'Bet cancelled', body: `The Gamb team cancelled your bet (${reason}). Your ${tokens(before.stake)} have been returned.`, data: { betId }, dedupeKey: `voided:${betId}` });
  return toAdminBetView(voided);
}
