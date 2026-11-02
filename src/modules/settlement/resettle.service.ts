import { Types } from 'mongoose';
import { withTransaction } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { publish } from '../../realtime/bus.js';
import { AppError } from '../../utils/errors.js';
import { withLock } from '../../utils/lock.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { Bet, type IBet } from '../bets/bet.model.js';
import { toBetView } from '../bets/bet.views.js';
import { recordSettlement } from '../leaderboard/leaderboard.service.js';
import { addExposure } from '../markets/liability.js';
import { Market, type IMarket, type ISelection, type MarketResult } from '../markets/market.model.js';
import { toMarketView } from '../markets/market.views.js';
import { notify } from '../notifications/notifications.service.js';
import { availableAccount, lockedAccount, type LedgerType } from '../wallet/accounts.js';
import { LedgerEntry } from '../wallet/ledger.model.js';
import { notifyWalletChanged, transferInSession, type TransferInput } from '../wallet/ledger.service.js';
import { buildManualResult, settleBet, type ManualSettleInput } from './settlement.service.js';

/** How each settlement posting is undone. Payout/refund reversals may push available below zero. */
function reversalOf(type: LedgerType, userId: string, amount: number, key: string, betId: string): TransferInput {
  const base = { amount, type: 'BET_RESETTLE_REVERSAL' as const, idempotencyKey: key, ref: { type: 'bet', id: betId }, meta: { reverses: type } };
  switch (type) {
    case 'BET_STAKE_CAPTURE':
      return { ...base, from: 'house', to: lockedAccount(userId) };
    case 'BET_PAYOUT':
      return { ...base, from: availableAccount(userId), to: 'house', allowNegative: true };
    case 'BET_REFUND':
      return { ...base, from: availableAccount(userId), to: lockedAccount(userId), allowNegative: true };
    default:
      throw new Error(`cannot reverse ${type}`);
  }
}

/**
 * Puts a settled bet back to ACCEPTED: reverses this round's settlement postings and bumps the
 * round so the next settlement gets fresh idempotency keys. One transaction per bet.
 */
async function reopenBet(bet: IBet): Promise<IBet | null> {
  const betId = bet._id.toString();
  const userId = bet.userId.toString();
  const round = bet.settlementRound ?? 0;
  const prefix = `settle:${betId}:r${round}:`;
  const postings = await LedgerEntry.find({ idempotencyKey: { $regex: `^${prefix}` }, direction: 'debit' }).lean();
  const reopened = await withTransaction(async (session) => {
    const updated = await Bet.findOneAndUpdate(
      { _id: bet._id, status: bet.status, version: bet.version },
      { $set: { status: 'ACCEPTED', payout: 0, settledAt: null, settlementRound: round + 1, 'legs.$[].result': 'PENDING', 'legs.$[].deadHeatWays': null }, $inc: { version: 1 } },
      { new: true, lean: true, session },
    );
    if (!updated) return null;
    for (const p of postings) {
      await transferInSession(reversalOf(p.type, userId, p.amount, `resettle:${betId}:r${round}:${p.type}`, betId), session);
    }
    return updated;
  });
  if (!reopened) return null;
  if (bet.status !== 'VOID') await recordSettlement(userId, bet.stake, bet.payout, bet.settledAt ?? new Date(), -1);
  for (const leg of bet.legs) await addExposure(leg.marketId.toString(), leg.selectionId, bet.stake, bet.potentialReturn);
  return reopened;
}

function statuses(selections: ISelection[], r: MarketResult): ISelection[] {
  return selections.map((s) => ({
    ...s,
    status: r.isVoid || r.voidSelectionIds.includes(s.id) ? 'VOID' : r.winningSelectionIds.includes(s.id) ? (r.deadHeatWays > 1 ? 'DEAD_HEAT' : 'WINNER') : 'LOSER',
  }));
}

export interface ResettleReport {
  market: IMarket;
  betsReopened: number;
  betsResettled: number;
}

/**
 * Corrects a settled market's result. Every affected bet is reversed in the ledger and settled
 * again under the new result; cash-outs and admin-voided bets are final and untouched.
 * Balances may go temporarily negative if a reversed payout was already spent.
 */
export async function resettleMarket(actor: AuditActor, marketId: string, input: ManualSettleInput): Promise<ResettleReport> {
  if (!Types.ObjectId.isValid(marketId)) throw AppError.notFound('Market');
  return withLock(
    `settle:market:${marketId}`,
    120_000,
    async () => {
      const m = await Market.findById(marketId).lean();
      if (!m) throw AppError.notFound('Market');
      if (m.status !== 'SETTLED' && m.status !== 'VOID') throw new AppError('INVALID_STATE', 'Only settled or void markets can be resettled');
      const result = buildManualResult(m, input);

      const affected = await Bet.find({ 'legs.marketId': m._id, status: { $in: ['WON', 'LOST', 'VOID'] }, voidReason: null }).lean();
      const reopened: IBet[] = [];
      for (const b of affected) {
        const r = await reopenBet(b);
        if (r) reopened.push(r);
      }

      const updated = await Market.findOneAndUpdate(
        { _id: m._id, version: m.version },
        { $set: { status: result.isVoid ? 'VOID' : 'SETTLED', result, selections: statuses(m.selections, result), settledAt: new Date() }, $inc: { version: 1 } },
        { new: true, lean: true },
      );
      if (!updated) throw new AppError('CONFLICT', 'Market changed during resettlement; retry');
      await recordAudit(actor, { action: 'market.resettle', targetType: 'market', targetId: marketId, reason: input.reason, before: { status: m.status, result: m.result }, after: { status: updated.status, result, betsAffected: reopened.length } });
      await publish('market.updated', { matchId: m.matchId.toString(), kind: 'status', market: toMarketView(updated) });

      let resettled = 0;
      for (const b of reopened) {
        try {
          const s = await settleBet(b._id.toString());
          if (s) resettled += 1;
          const userId = b.userId.toString();
          const fresh = s ?? (await Bet.findById(b._id).lean());
          if (fresh) await publish('bet.updated', { userId, bet: toBetView(fresh) });
          await notifyWalletChanged([userId], 'RESETTLE');
          await notify({
            userId,
            type: 'BET_RESETTLED',
            title: 'Result corrected',
            body: `The result of "${m.name}" was corrected. Your bet has been updated.`,
            data: { betId: b._id.toString(), marketId },
            dedupeKey: `resettled:${b._id.toString()}:r${b.settlementRound}`,
          });
        } catch (err) {
          logger.error({ err, betId: b._id.toString() }, 'resettlement of bet failed; catch-up will retry');
        }
      }
      return { market: updated, betsReopened: reopened.length, betsResettled: resettled };
    },
    () => {
      throw new AppError('CONFLICT', 'This market is being settled right now');
    },
  );
}
