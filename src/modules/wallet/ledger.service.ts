import { randomUUID } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { withTransaction } from '../../config/db.js';
import { publish } from '../../realtime/bus.js';
import { AppError } from '../../utils/errors.js';
import { assertPositiveUnits } from '../../utils/money.js';
import { assertRouteAllowed, parseAccount, type LedgerAccount, type LedgerType, type ParsedAccount } from './accounts.js';
import { LedgerEntry, type ILedgerEntry } from './ledger.model.js';
import { Wallet, type IWallet } from './wallet.model.js';

export interface TransferInput {
  from: LedgerAccount;
  to: LedgerAccount;
  amount: number;
  type: LedgerType;
  /** Globally unique per logical movement, e.g. `welcome:<userId>`, `settle:<betId>:payout`. */
  idempotencyKey: string;
  ref?: { type: string; id: string };
  /** For BET_RESETTLE_REVERSAL, `meta.reverses` must name the type being undone. */
  meta?: Record<string, unknown>;
  /** Only reversals may push a user's available balance below zero (they may have spent a payout). */
  allowNegative?: boolean;
}

export interface TransferResult {
  txnId: string;
  duplicate: boolean;
  affectedUserIds: string[];
}

/** Thrown when the wallet changed between read and write; labelled so withTransaction retries. */
class WalletVersionConflict extends Error {
  readonly errorLabels = ['TransientTransactionError'];
  constructor() {
    super('wallet version conflict');
  }
}

type LifetimeKey = keyof IWallet['lifetime'];

/** How a posting moves the lifetime counters. Shared with reconciliation so both agree. */
export function lifetimeEffect(type: LedgerType, amount: number, meta: Record<string, unknown> | null | undefined): Partial<Record<LifetimeKey, number>> {
  switch (type) {
    case 'BET_STAKE_CAPTURE':
      return { staked: amount };
    case 'BET_PAYOUT':
    case 'CASHOUT':
      return { returned: amount };
    case 'WELCOME_BONUS':
    case 'DAILY_BONUS':
      return { bonuses: amount };
    case 'ADMIN_CREDIT':
      return { adminCredits: amount };
    case 'ADMIN_DEBIT':
      return { adminDebits: amount };
    case 'BET_RESETTLE_REVERSAL': {
      const reverses = meta?.reverses;
      if (reverses === 'BET_PAYOUT' || reverses === 'CASHOUT') return { returned: -amount };
      if (reverses === 'BET_STAKE_CAPTURE') return { staked: -amount };
      return {};
    }
    default:
      return {};
  }
}

interface Delta {
  available: number;
  locked: number;
}

function applyLeg(deltas: Map<string, Delta>, acc: ParsedAccount, signed: number): void {
  if (!acc.userId) return;
  const d = deltas.get(acc.userId) ?? { available: 0, locked: 0 };
  if (acc.kind === 'locked') d.locked += signed;
  else d.available += signed;
  deltas.set(acc.userId, d);
}

function validate(input: TransferInput): { from: ParsedAccount; to: ParsedAccount } {
  assertPositiveUnits(input.amount);
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error('idempotencyKey is required (≤200 chars)');
  const from = parseAccount(input.from);
  const to = parseAccount(input.to);
  if (from.account === to.account) throw new Error('cannot transfer to the same account');
  assertRouteAllowed(input.type, from, to);
  if (input.type === 'BET_RESETTLE_REVERSAL' && typeof input.meta?.reverses !== 'string') {
    throw new Error('reversal postings must set meta.reverses');
  }
  return { from, to };
}

/**
 * Posts one balanced transfer inside the caller's transaction. Idempotent: replaying the same
 * key returns the original txn; reusing a key with different parameters is refused.
 */
export async function transferInSession(input: TransferInput, session: ClientSession): Promise<TransferResult> {
  const { from, to } = validate(input);

  const existing = await LedgerEntry.findOne({ idempotencyKey: input.idempotencyKey, direction: 'debit' }).session(session).lean();
  if (existing) {
    const same = existing.account === from.account && existing.counterparty === to.account && existing.amount === input.amount && existing.type === input.type;
    if (!same) throw new AppError('DUPLICATE_REQUEST', 'Idempotency key was already used for a different transfer');
    return { txnId: existing.txnId, duplicate: true, affectedUserIds: [] };
  }

  const deltas = new Map<string, Delta>();
  applyLeg(deltas, from, -input.amount);
  applyLeg(deltas, to, input.amount);
  const effect = lifetimeEffect(input.type, input.amount, input.meta);
  // Lifetime counters belong to the user on the non-house side of the posting.
  const lifetimeOwner = from.userId ?? to.userId;

  const after = new Map<string, Delta>();
  for (const userId of [...deltas.keys()].sort()) {
    const d = deltas.get(userId) as Delta;
    const wallet = await Wallet.findOne({ userId: new Types.ObjectId(userId) }).session(session).lean();
    if (!wallet) throw new AppError('NOT_FOUND', 'Wallet not found');

    const lockedAfter = wallet.lockedBalance + d.locked;
    const balanceAfter = wallet.balance + d.available + d.locked;
    const availableAfter = balanceAfter - lockedAfter;
    if (lockedAfter < 0) throw new Error(`locked balance would go negative for ${userId}`);
    if (d.available < 0 && availableAfter < 0 && !input.allowNegative) {
      throw new AppError('INSUFFICIENT_BALANCE', 'Not enough available tokens', {
        available: wallet.balance - wallet.lockedBalance,
        required: -d.available,
      });
    }

    const inc: Record<string, number> = { version: 1 };
    if (userId === lifetimeOwner) for (const [k, v] of Object.entries(effect)) inc[`lifetime.${k}`] = v;
    const res = await Wallet.updateOne(
      { _id: wallet._id, version: wallet.version },
      { $set: { balance: balanceAfter, lockedBalance: lockedAfter }, $inc: inc },
      { session },
    );
    if (res.matchedCount !== 1) throw new WalletVersionConflict();
    after.set(userId, { available: availableAfter, locked: lockedAfter });
  }

  const txnId = randomUUID();
  const leg = (acc: ParsedAccount, counter: ParsedAccount, direction: 'debit' | 'credit'): Omit<ILedgerEntry, '_id' | 'createdAt'> => {
    const a = acc.userId ? after.get(acc.userId) : undefined;
    return {
      txnId,
      account: acc.account,
      userId: acc.userId ? new Types.ObjectId(acc.userId) : null,
      direction,
      amount: input.amount,
      balanceAfter: a ? (acc.kind === 'locked' ? a.locked : a.available) : null,
      type: input.type,
      refType: input.ref?.type ?? null,
      refId: input.ref?.id ?? null,
      idempotencyKey: input.idempotencyKey,
      counterparty: counter.account,
      meta: input.meta ?? null,
    };
  };
  await LedgerEntry.insertMany([leg(from, to, 'debit'), leg(to, from, 'credit')], { session });

  return { txnId, duplicate: false, affectedUserIds: [...deltas.keys()] };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * Several postings as one atomic unit (e.g. settle a winning bet = capture stake + pay out).
 * Opens its own transaction and publishes wallet events after commit.
 */
export async function transferAll(inputs: TransferInput[], reason?: string): Promise<TransferResult[]> {
  const run = () => withTransaction(async (session) => {
    const out: TransferResult[] = [];
    for (const input of inputs) out.push(await transferInSession(input, session));
    return out;
  });
  let results: TransferResult[];
  try {
    results = await run();
  } catch (err) {
    // A concurrent replay of the same key committed first: re-run to get the idempotent result.
    if (!isDuplicateKey(err)) throw err;
    results = await run();
  }
  await notifyWalletChanged(results.flatMap((r) => r.affectedUserIds), reason ?? inputs[0]?.type ?? 'ledger');
  return results;
}

/** The single entry point for moving tokens outside an existing transaction. */
export async function transfer(input: TransferInput): Promise<TransferResult> {
  const [result] = await transferAll([input], input.type);
  if (!result) throw new Error('transfer produced no result');
  return result;
}

export async function notifyWalletChanged(userIds: string[], reason: string): Promise<void> {
  await Promise.all([...new Set(userIds)].map((userId) => publish('wallet.changed', { userId, reason })));
}
