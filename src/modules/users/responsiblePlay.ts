import type { ResponsiblePlay } from './user.model.js';

export const LIMIT_INCREASE_DELAY_MS = 24 * 3600 * 1000;

type LimitKey = 'dailyStakeLimit' | 'dailyLossLimit';
const LIMIT_KEYS: LimitKey[] = ['dailyStakeLimit', 'dailyLossLimit'];

/** null = unlimited, so it is "looser" than any number. */
function isLoosening(current: number | null, next: number | null): boolean {
  if (current === null) return false;
  if (next === null) return true;
  return next > current;
}

export interface LimitChangePlan {
  immediate: Partial<Record<LimitKey, number | null>>;
  deferred: Partial<Record<LimitKey, number | null>>;
}

/**
 * Industry rule: tightening a limit applies at once; loosening it waits 24h,
 * so nobody raises a limit on impulse mid-session.
 */
export function planLimitChange(current: ResponsiblePlay, next: Record<LimitKey, number | null>): LimitChangePlan {
  const plan: LimitChangePlan = { immediate: {}, deferred: {} };
  for (const key of LIMIT_KEYS) {
    if (current[key] === next[key]) continue;
    if (isLoosening(current[key], next[key])) plan.deferred[key] = next[key];
    else plan.immediate[key] = next[key];
  }
  return plan;
}

/** Applies a pending increase whose cooling-off period has passed. Returns true if anything changed. */
export function applyDuePendingIncrease(rp: ResponsiblePlay, now = new Date()): boolean {
  const pending = rp.pendingIncrease;
  if (!pending || pending.effectiveAt > now) return false;
  for (const key of LIMIT_KEYS) {
    const value = pending[key];
    if (value !== undefined) rp[key] = value;
  }
  rp.pendingIncrease = null;
  return true;
}

export type PlayBlock = { code: 'ACCOUNT_SUSPENDED' | 'ACCOUNT_SELF_EXCLUDED' | 'ACCOUNT_IN_COOLDOWN'; until: Date | null } | null;

/** Why this user can't place bets right now, if anything. */
export function playBlock(status: string, rp: ResponsiblePlay, now = new Date()): PlayBlock {
  if (status === 'suspended') return { code: 'ACCOUNT_SUSPENDED', until: null };
  if (status === 'self_excluded' && (!rp.selfExcludedUntil || rp.selfExcludedUntil > now)) {
    return { code: 'ACCOUNT_SELF_EXCLUDED', until: rp.selfExcludedUntil };
  }
  if (rp.cooldownUntil && rp.cooldownUntil > now) return { code: 'ACCOUNT_IN_COOLDOWN', until: rp.cooldownUntil };
  return null;
}
