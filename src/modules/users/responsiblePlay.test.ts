import { describe, expect, it } from 'vitest';
import type { ResponsiblePlay } from './user.model.js';
import { applyDuePendingIncrease, planLimitChange, playBlock } from './responsiblePlay.js';

function rp(overrides: Partial<ResponsiblePlay> = {}): ResponsiblePlay {
  return {
    dailyStakeLimit: null,
    dailyLossLimit: null,
    sessionReminderMinutes: null,
    cooldownUntil: null,
    selfExcludedUntil: null,
    pendingIncrease: null,
    ...overrides,
  };
}

describe('planLimitChange', () => {
  it('applies a first-time limit immediately (it tightens "unlimited")', () => {
    const plan = planLimitChange(rp(), { dailyStakeLimit: 50_000, dailyLossLimit: null });
    expect(plan).toEqual({ immediate: { dailyStakeLimit: 50_000 }, deferred: {} });
  });

  it('defers raising or removing a limit', () => {
    const plan = planLimitChange(rp({ dailyStakeLimit: 10_000, dailyLossLimit: 5_000 }), {
      dailyStakeLimit: 20_000,
      dailyLossLimit: null,
    });
    expect(plan).toEqual({ immediate: {}, deferred: { dailyStakeLimit: 20_000, dailyLossLimit: null } });
  });

  it('splits a mixed change', () => {
    const plan = planLimitChange(rp({ dailyStakeLimit: 10_000, dailyLossLimit: 5_000 }), {
      dailyStakeLimit: 8_000,
      dailyLossLimit: 9_000,
    });
    expect(plan).toEqual({ immediate: { dailyStakeLimit: 8_000 }, deferred: { dailyLossLimit: 9_000 } });
  });

  it('ignores unchanged values', () => {
    expect(planLimitChange(rp({ dailyStakeLimit: 1_000 }), { dailyStakeLimit: 1_000, dailyLossLimit: null })).toEqual({
      immediate: {},
      deferred: {},
    });
  });
});

describe('applyDuePendingIncrease', () => {
  it('applies only once the cooling-off period has passed', () => {
    const state = rp({ dailyStakeLimit: 1_000, pendingIncrease: { dailyStakeLimit: 5_000, effectiveAt: new Date('2026-01-02') } });
    expect(applyDuePendingIncrease(state, new Date('2026-01-01'))).toBe(false);
    expect(state.dailyStakeLimit).toBe(1_000);
    expect(applyDuePendingIncrease(state, new Date('2026-01-03'))).toBe(true);
    expect(state.dailyStakeLimit).toBe(5_000);
    expect(state.pendingIncrease).toBeNull();
  });

  it('can remove a limit (null)', () => {
    const state = rp({ dailyLossLimit: 1_000, pendingIncrease: { dailyLossLimit: null, effectiveAt: new Date(0) } });
    applyDuePendingIncrease(state);
    expect(state.dailyLossLimit).toBeNull();
  });
});

describe('playBlock', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  it('allows active accounts', () => expect(playBlock('active', rp(), now)).toBeNull());
  it('blocks suspended accounts', () => expect(playBlock('suspended', rp(), now)?.code).toBe('ACCOUNT_SUSPENDED'));
  it('blocks during a cooldown and lifts after it', () => {
    const state = rp({ cooldownUntil: new Date('2026-06-02T00:00:00Z') });
    expect(playBlock('active', state, now)?.code).toBe('ACCOUNT_IN_COOLDOWN');
    expect(playBlock('active', state, new Date('2026-06-03T00:00:00Z'))).toBeNull();
  });
  it('treats a permanent self-exclusion as always blocked', () => {
    expect(playBlock('self_excluded', rp({ selfExcludedUntil: null }), now)?.code).toBe('ACCOUNT_SELF_EXCLUDED');
  });
});
