import { describe, expect, it } from 'vitest';
import { cashoutOffer, comboOdds, MAX_ACCA_ODDS, potentialReturn, settleLegs } from './math.js';

describe('accumulator odds', () => {
  it('multiplies and rounds down', () => {
    expect(comboOdds([185])).toBe(185);
    expect(comboOdds([200, 150])).toBe(300);
    expect(comboOdds([185, 210, 133])).toBe(516); // 1.85 × 2.10 × 1.33 = 5.16705 → 5.16
  });
  it('caps absurd combinations', () => {
    expect(comboOdds([10_000, 10_000, 10_000])).toBe(MAX_ACCA_ODDS);
  });
  it('rejects bad odds', () => {
    expect(() => comboOdds([])).toThrow();
    expect(() => comboOdds([1.85])).toThrow();
  });
});

describe('returns', () => {
  it('computes integer returns without float drift', () => {
    expect(potentialReturn(1_000, 185)).toBe(1_850);
    expect(potentialReturn(333, 133)).toBe(442); // 442.89 → 442
    expect(potentialReturn(9_007_199_254, 10_000)).toBe(900_719_925_400);
  });
});

describe('cash out', () => {
  it('locks in profit when the price has shortened', () => {
    // Backed at 3.00 for 100; now 1.50: fair value 200, less 5% = 190.
    expect(cashoutOffer(100_00, 300, 150, 500)).toBe(190_00);
  });
  it('cuts losses when the price has drifted', () => {
    expect(cashoutOffer(100_00, 200, 400, 500)).toBe(47_50);
  });
  it('is never worth the full win and never zero', () => {
    // At the shortest price the offer approaches, but never reaches, the full return.
    expect(cashoutOffer(100_00, 300, 101, 0)).toBe(297_02);
    expect(cashoutOffer(100_00, 300, 101, 0)).toBeLessThan(potentialReturn(100_00, 300));
    expect(cashoutOffer(1, 101, 10_000, 500)).toBe(1);
  });
});

describe('settleLegs', () => {
  const W = (odds: number) => ({ outcome: 'WON' as const, odds });
  it('single win and loss', () => {
    expect(settleLegs(100_00, [W(185)])).toEqual({ status: 'WON', effectiveOdds: 185, payout: 185_00 });
    expect(settleLegs(100_00, [{ outcome: 'LOST', odds: 185 }]).status).toBe('LOST');
  });
  it('any losing leg loses the acca immediately', () => {
    expect(settleLegs(100, [W(200), { outcome: 'PENDING', odds: 300 }, { outcome: 'LOST', odds: 150 }]).status).toBe('LOST');
  });
  it('waits for pending legs', () => {
    expect(settleLegs(100, [W(200), { outcome: 'PENDING', odds: 300 }]).status).toBe('PENDING');
  });
  it('drops void legs and recalculates', () => {
    expect(settleLegs(100_00, [W(200), { outcome: 'VOID', odds: 300 }, W(150)])).toEqual({ status: 'WON', effectiveOdds: 300, payout: 300_00 });
  });
  it('refunds when every leg is void', () => {
    expect(settleLegs(100_00, [{ outcome: 'VOID', odds: 300 }])).toEqual({ status: 'VOID', effectiveOdds: 100, payout: 100_00 });
  });
  it('applies dead heats', () => {
    expect(settleLegs(100_00, [{ outcome: 'DEAD_HEAT', odds: 300, deadHeatWays: 2 }])).toEqual({ status: 'WON', effectiveOdds: 150, payout: 150_00 });
    // Dead heat at short odds can return less than the stake; that's the rule.
    expect(settleLegs(100_00, [{ outcome: 'DEAD_HEAT', odds: 150, deadHeatWays: 2 }]).payout).toBe(75_00);
  });
});
