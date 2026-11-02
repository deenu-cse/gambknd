import { Types } from 'mongoose';

/**
 * Ledger accounts.
 *  user:<id>         the user's free tokens (= wallet available balance)
 *  user:<id>:locked  the user's tokens committed to open bets (= wallet lockedBalance)
 *  house             the book: receives losing stakes, pays winnings
 *  bonus_pool        source of welcome/daily bonuses
 *  admin_mint        source/sink of admin credits/debits
 * wallet.balance (total) = user:<id> + user:<id>:locked.
 * System accounts may go negative: they are where tokens come from.
 */
export const SYSTEM_ACCOUNTS = ['house', 'bonus_pool', 'admin_mint'] as const;
export type SystemAccount = (typeof SYSTEM_ACCOUNTS)[number];
export type UserAccount = `user:${string}`;
export type LedgerAccount = SystemAccount | UserAccount;

export const LEDGER_TYPES = [
  'ADMIN_CREDIT',
  'ADMIN_DEBIT',
  'WELCOME_BONUS',
  'DAILY_BONUS',
  'BET_STAKE', // available → locked when a bet is placed
  'BET_REFUND', // locked → available when a bet is rejected or voided
  'BET_STAKE_CAPTURE', // locked → house when a bet settles (won, lost or cashed out)
  'BET_PAYOUT', // house → available for a winning bet
  'CASHOUT', // house → available for a cash-out
  'BET_RESETTLE_REVERSAL', // undoes a previous settlement posting
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export interface ParsedAccount {
  kind: 'system' | 'available' | 'locked';
  userId: string | null;
  account: LedgerAccount;
}

export function availableAccount(userId: string): UserAccount {
  return `user:${userId}`;
}

export function lockedAccount(userId: string): UserAccount {
  return `user:${userId}:locked`;
}

export function parseAccount(account: string): ParsedAccount {
  if ((SYSTEM_ACCOUNTS as readonly string[]).includes(account)) {
    return { kind: 'system', userId: null, account: account as SystemAccount };
  }
  const m = /^user:([0-9a-f]{24})(:locked)?$/.exec(account);
  if (!m?.[1] || !Types.ObjectId.isValid(m[1])) throw new Error(`invalid ledger account: ${account}`);
  return { kind: m[2] ? 'locked' : 'available', userId: m[1], account: account as UserAccount };
}

type Kind = ParsedAccount['kind'];
type Route = { from: Kind | SystemAccount; to: Kind | SystemAccount; sameUser?: boolean };

/** Which movements each type may make. Anything else is a programming error and is refused. */
const ROUTES: Record<LedgerType, Route[]> = {
  ADMIN_CREDIT: [{ from: 'admin_mint', to: 'available' }],
  ADMIN_DEBIT: [{ from: 'available', to: 'admin_mint' }],
  WELCOME_BONUS: [{ from: 'bonus_pool', to: 'available' }],
  DAILY_BONUS: [{ from: 'bonus_pool', to: 'available' }],
  BET_STAKE: [{ from: 'available', to: 'locked', sameUser: true }],
  BET_REFUND: [{ from: 'locked', to: 'available', sameUser: true }],
  BET_STAKE_CAPTURE: [{ from: 'locked', to: 'house' }],
  BET_PAYOUT: [{ from: 'house', to: 'available' }],
  CASHOUT: [{ from: 'house', to: 'available' }],
  BET_RESETTLE_REVERSAL: [
    { from: 'available', to: 'house' }, // take back a payout / cash-out
    { from: 'house', to: 'locked' }, // un-capture a stake (bet becomes open again)
    { from: 'available', to: 'locked', sameUser: true }, // undo a refund
  ],
};

function matches(side: Kind | SystemAccount, acc: ParsedAccount): boolean {
  return acc.kind === 'system' ? side === acc.account : side === acc.kind;
}

export function assertRouteAllowed(type: LedgerType, from: ParsedAccount, to: ParsedAccount): void {
  const ok = ROUTES[type].some(
    (r) => matches(r.from, from) && matches(r.to, to) && (!r.sameUser || (from.userId !== null && from.userId === to.userId)),
  );
  if (!ok) throw new Error(`ledger route not allowed: ${type} ${from.account} → ${to.account}`);
}
