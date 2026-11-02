import { Types, type ClientSession } from 'mongoose';
import { withTransaction } from '../../config/db.js';
import { AppError } from '../../utils/errors.js';
import { withLock } from '../../utils/lock.js';
import { UNITS_PER_TOKEN } from '../../utils/money.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { getSettings } from '../settings/settings.service.js';
import { isStaff, User } from '../users/user.model.js';
import { playBlock } from '../users/responsiblePlay.js';
import { availableAccount, lockedAccount, type LedgerType } from './accounts.js';
import { LedgerEntry } from './ledger.model.js';
import { notifyWalletChanged, transferInSession } from './ledger.service.js';
import { Wallet, type IWallet } from './wallet.model.js';
import { notify, tokens } from '../notifications/notifications.service.js';

const DAILY_BONUS_INTERVAL_MS = 24 * 3600 * 1000;

/** Creates the wallet and pays the welcome bonus inside the caller's (registration) transaction. */
export async function provisionWallet(userId: Types.ObjectId, session: ClientSession): Promise<void> {
  await Wallet.create([{ userId }], { session });
  const { welcomeBonus } = await getSettings(session);
  if (welcomeBonus > 0) {
    await transferInSession(
      {
        from: 'bonus_pool',
        to: availableAccount(userId.toString()),
        amount: welcomeBonus,
        type: 'WELCOME_BONUS',
        idempotencyKey: `welcome:${userId.toString()}`,
        ref: { type: 'user', id: userId.toString() },
      },
      session,
    );
  }
}

export interface DailyBonusStatus {
  amount: number;
  available: boolean;
  nextAvailableAt: Date | null;
}

export interface WalletSummary {
  unitsPerToken: number;
  balance: number;
  locked: number;
  available: number;
  lifetimeStaked: number;
  lifetimeWon: number;
  lifetimeBonuses: number;
  netPnl: number;
  dailyBonus: DailyBonusStatus;
  updatedAt: Date;
}

function dailyStatus(wallet: Pick<IWallet, 'lastDailyBonusAt'>, amount: number, now = new Date()): DailyBonusStatus {
  const next = wallet.lastDailyBonusAt ? new Date(wallet.lastDailyBonusAt.getTime() + DAILY_BONUS_INTERVAL_MS) : null;
  const available = amount > 0 && (!next || next <= now);
  return { amount, available, nextAvailableAt: available ? null : next };
}

async function loadWallet(userId: string, session?: ClientSession) {
  if (!Types.ObjectId.isValid(userId)) throw AppError.notFound('Wallet');
  const wallet = await Wallet.findOne({ userId: new Types.ObjectId(userId) }, null, session ? { session } : {}).lean();
  if (!wallet) throw AppError.notFound('Wallet');
  return wallet;
}

export async function getWalletSummary(userId: string): Promise<WalletSummary> {
  const [wallet, settings] = await Promise.all([loadWallet(userId), getSettings()]);
  return {
    unitsPerToken: UNITS_PER_TOKEN,
    balance: wallet.balance,
    locked: wallet.lockedBalance,
    available: wallet.balance - wallet.lockedBalance,
    lifetimeStaked: wallet.lifetime.staked,
    lifetimeWon: wallet.lifetime.returned,
    lifetimeBonuses: wallet.lifetime.bonuses,
    netPnl: wallet.lifetime.returned - wallet.lifetime.staked,
    dailyBonus: dailyStatus(wallet, settings.dailyBonus),
    updatedAt: wallet.updatedAt,
  };
}

export async function claimDailyBonus(userId: string): Promise<WalletSummary> {
  const user = await User.findById(userId).select('status responsiblePlay').lean();
  if (!user) throw AppError.notFound('User');
  const block = playBlock(user.status, user.responsiblePlay);
  if (block) throw new AppError(block.code, 'Bonuses are paused on this account', { until: block.until });

  await withLock(
    `daily-bonus:${userId}`,
    10_000,
    async () => {
      await withTransaction(async (session) => {
        const settings = await getSettings(session);
        const wallet = await loadWallet(userId, session);
        const status = dailyStatus(wallet, settings.dailyBonus);
        if (!status.available) {
          throw new AppError('BONUS_NOT_AVAILABLE', 'Daily bonus already claimed', { nextAvailableAt: status.nextAvailableAt });
        }
        const now = new Date();
        await Wallet.updateOne({ _id: wallet._id }, { $set: { lastDailyBonusAt: now } }, { session });
        await transferInSession(
          {
            from: 'bonus_pool',
            to: availableAccount(userId),
            amount: settings.dailyBonus,
            type: 'DAILY_BONUS',
            // Ledger-level guard on top of the 24h rule: at most one daily bonus per UTC date.
            idempotencyKey: `daily:${userId}:${now.toISOString().slice(0, 10)}`,
            ref: { type: 'user', id: userId },
          },
          session,
        );
      });
    },
    () => {
      throw new AppError('DUPLICATE_REQUEST', 'A bonus claim is already in progress');
    },
  );
  await notifyWalletChanged([userId], 'DAILY_BONUS');
  return getWalletSummary(userId);
}

export interface TransactionQuery {
  types?: LedgerType[];
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface TransactionView {
  id: string;
  txnId: string;
  type: LedgerType;
  bucket: 'available' | 'locked';
  direction: 'debit' | 'credit';
  amount: number;
  /** + for money into this bucket, − for money out. */
  signedAmount: number;
  balanceAfter: number | null;
  refType: string | null;
  refId: string | null;
  createdAt: Date;
}

export async function listTransactions(userId: string, q: TransactionQuery): Promise<{ items: TransactionView[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = { account: { $in: [availableAccount(userId), lockedAccount(userId)] } };
  if (q.types?.length) filter.type = { $in: q.types };
  if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.cursor) filter._id = { $lt: new Types.ObjectId(q.cursor) };

  const rows = await LedgerEntry.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((e) => ({
      id: e._id.toString(),
      txnId: e.txnId,
      type: e.type,
      bucket: e.account.endsWith(':locked') ? 'locked' : 'available',
      direction: e.direction,
      amount: e.amount,
      signedAmount: e.direction === 'credit' ? e.amount : -e.amount,
      balanceAfter: e.balanceAfter,
      refType: e.refType,
      refId: e.refId,
      createdAt: e.createdAt,
    })),
    nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null,
  };
}

export interface AdminAdjustmentInput {
  targetUserId: string;
  direction: 'credit' | 'debit';
  amount: number;
  reason: string;
  idempotencyKey: string;
}

/** Admin credit/debit: reasoned, capped, audited in the same transaction, never on yourself. */
export async function adminAdjust(actor: AuditActor & { id: string }, input: AdminAdjustmentInput): Promise<WalletSummary> {
  if (actor.id === input.targetUserId) throw new AppError('SELF_ACTION_FORBIDDEN', 'You cannot adjust your own wallet');
  if (!Types.ObjectId.isValid(input.targetUserId)) throw AppError.notFound('User');
  const target = await User.findById(input.targetUserId).select('role').lean();
  if (!target) throw AppError.notFound('User');
  if (isStaff(target.role) && actor.role !== 'superadmin') throw AppError.forbidden('Only a superadmin can adjust staff wallets');

  const settings = await getSettings();
  if (input.amount > settings.adminMaxAdjustment) {
    throw new AppError('STAKE_LIMIT', 'Amount exceeds the per-action admin limit', { max: settings.adminMaxAdjustment });
  }

  const type: LedgerType = input.direction === 'credit' ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT';
  const userAcc = availableAccount(input.targetUserId);
  const result = await withTransaction(async (session) => {
    const before = await loadWallet(input.targetUserId, session);
    const r = await transferInSession(
      {
        from: input.direction === 'credit' ? 'admin_mint' : userAcc,
        to: input.direction === 'credit' ? userAcc : 'admin_mint',
        amount: input.amount,
        type,
        idempotencyKey: `admin:${actor.id}:${input.idempotencyKey}`,
        ref: { type: 'admin_action', id: input.idempotencyKey },
        meta: { reason: input.reason, actorId: actor.id },
      },
      session,
    );
    if (!r.duplicate) {
      await recordAudit(
        actor,
        {
          action: input.direction === 'credit' ? 'wallet.admin_credit' : 'wallet.admin_debit',
          targetType: 'user',
          targetId: input.targetUserId,
          reason: input.reason,
          before: { balance: before.balance, locked: before.lockedBalance },
          after: { amount: input.amount, txnId: r.txnId },
        },
        session,
      );
    }
    return r;
  });
  await notifyWalletChanged(result.affectedUserIds, type);
  if (!result.duplicate) {
    await notify({
      userId: input.targetUserId,
      type,
      title: input.direction === 'credit' ? 'Tokens added' : 'Tokens removed',
      body: `${tokens(input.amount)} ${input.direction === 'credit' ? 'added to' : 'removed from'} your wallet by the Gamb team: ${input.reason}`,
      data: { txnId: result.txnId },
      dedupeKey: `admin-adjust:${result.txnId}`,
    });
  }
  return getWalletSummary(input.targetUserId);
}
