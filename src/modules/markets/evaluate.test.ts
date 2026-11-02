import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { IMatch } from '../matches/match.model.js';
import { evaluateMarket, type EvalInput } from './evaluate.js';
import type { IMarket } from './market.model.js';
import type { PricingContext } from './pricing/context.js';
import { canTransition } from './stateMachine.js';

const settings = { oneSidedThresholdBps: 9700, shadingStartBps: 5000, shadingMaxBoostBps: 1500 };
const noBall: EvalInput = { ball: null, reopenToken: null, book: null, settings };

function market(over: Partial<IMarket> = {}): IMarket {
  return {
    _id: new Types.ObjectId(), matchId: new Types.ObjectId(), key: 'CUSTOM:1', type: 'CUSTOM', group: 'SPECIALS', name: 'Custom',
    params: {}, status: 'OPEN', suspendReason: null, suspendToken: null, lastSuspendedAt: null, inPlay: true, autoManaged: false, marginBps: 0, betDelayMs: 0,
    minStake: 100, maxStake: 1000, maxLiability: 100_000, lineX10: null, sortOrder: 1, result: null, settledAt: null, closedAt: null,
    lastPricedAt: null, version: 0, createdBy: 'test', createdAt: new Date(), updatedAt: new Date(),
    selections: [
      { id: 'a', name: 'A', teamKey: null, playerId: null, odds: 190, probabilityBps: 0, status: 'ACTIVE' },
      { id: 'b', name: 'B', teamKey: null, playerId: null, odds: 190, probabilityBps: 0, status: 'ACTIVE' },
    ],
    ...over,
  };
}

function ctx(match: Partial<IMatch> = {}, finished = false): PricingContext {
  return {
    match: { bettingEnabled: true, stale: false, status: 'LIVE', statusText: 'X need 20 runs', ...match } as IMatch,
    finished,
  } as PricingContext;
}

describe('evaluateMarket: status priorities', () => {
  it('closes everything when the match finishes', () => {
    expect(evaluateMarket(market(), ctx({}, true), noBall)?.status).toBe('CLOSED');
  });
  it('leaves settled/closed/void markets alone', () => {
    for (const status of ['CLOSED', 'SETTLED', 'VOID'] as const) expect(evaluateMarket(market({ status }), ctx(), noBall)).toBeNull();
  });
  it('keeps admin suspensions sticky, even when everything else is fine', () => {
    expect(evaluateMarket(market({ status: 'SUSPENDED', suspendReason: 'ADMIN' }), ctx(), noBall)).toBeNull();
  });
  it.each([
    [{ bettingEnabled: false }, 'BETTING_DISABLED'],
    [{ stale: true }, 'STALE'],
    [{ status: 'RAIN_DELAY' as const }, 'RAIN'],
    [{ statusText: 'Review: third umpire checking' }, 'REVIEW'],
  ])('suspends in-play markets for %o', (m, reason) => {
    expect(evaluateMarket(market(), ctx(m), noBall)).toMatchObject({ status: 'SUSPENDED', suspendReason: reason });
  });
  it('does not stale-suspend pre-match markets', () => {
    expect(evaluateMarket(market({ inPlay: false }), ctx({ stale: true }), noBall)).toBeNull();
  });
  it('suspends on a delivery and only the matching reopen token lifts it', () => {
    const suspended = evaluateMarket(market(), ctx(), { ...noBall, ball: { reason: 'WICKET', token: 't1' } });
    expect(suspended).toMatchObject({ status: 'SUSPENDED', suspendReason: 'WICKET', suspendToken: 't1' });
    const m = market({ status: 'SUSPENDED', suspendReason: 'WICKET', suspendToken: 't1' });
    expect(evaluateMarket(m, ctx(), noBall)).toBeNull(); // no token: stays suspended, unchanged
    expect(evaluateMarket(m, ctx(), { ...noBall, reopenToken: 't0' })).toBeNull(); // stale token
    expect(evaluateMarket(m, ctx(), { ...noBall, reopenToken: 't1' })).toMatchObject({ status: 'OPEN', suspendReason: null });
  });
  it('lifts condition suspensions as soon as the condition clears', () => {
    expect(evaluateMarket(market({ status: 'SUSPENDED', suspendReason: 'STALE' }), ctx(), noBall)).toMatchObject({ status: 'OPEN' });
  });
});

describe('state machine', () => {
  it('allows the documented transitions only', () => {
    expect(canTransition('PENDING', 'OPEN')).toBe(true);
    expect(canTransition('OPEN', 'SUSPENDED')).toBe(true);
    expect(canTransition('SUSPENDED', 'OPEN')).toBe(true);
    expect(canTransition('CLOSED', 'SETTLED')).toBe(true);
    expect(canTransition('SUSPENDED', 'VOID')).toBe(true);
    expect(canTransition('CLOSED', 'OPEN')).toBe(false);
    expect(canTransition('SETTLED', 'VOID')).toBe(false);
    expect(canTransition('VOID', 'OPEN')).toBe(false);
  });
});
