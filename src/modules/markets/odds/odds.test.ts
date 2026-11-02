import { describe, expect, it } from 'vitest';
import { LADDER, MAX_ODDS, MIN_ODDS, isOnLadder, toLadder } from './ladder.js';
import { bookOverroundBps, normalizeBps, oddsFromProbability, priceSelections } from './margin.js';
import * as P from './probability.js';
import { applyLiabilityShading } from './shading.js';

describe('odds ladder', () => {
  it('is strictly increasing between 1.01 and 100', () => {
    expect(LADDER[0]).toBe(MIN_ODDS);
    expect(LADDER.at(-1)).toBe(MAX_ODDS);
    for (let i = 1; i < LADDER.length; i += 1) expect(LADDER[i]).toBeGreaterThan(LADDER[i - 1]!);
  });
  it('snaps down by default, never giving away a better price', () => {
    expect(toLadder(203)).toBe(202);
    expect(toLadder(203, 'up')).toBe(204);
    expect(toLadder(307)).toBe(305);
    expect(toLadder(1234)).toBe(1200);
    expect(toLadder(99)).toBe(101);
    expect(toLadder(1e9)).toBe(10_000);
    expect(isOnLadder(185)).toBe(true);
    expect(isOnLadder(201)).toBe(false);
  });
});

describe('margin', () => {
  it('normalizes to exactly 10,000 bps', () => {
    const n = normalizeBps({ a: 1, b: 1, c: 1 });
    expect(Object.values(n).reduce((s, v) => s + v, 0)).toBe(10_000);
  });
  it('turns evens into ~1.90 at 5% and never under-margins', () => {
    const odds = priceSelections({ a: 5000, b: 5000 }, 500);
    expect(odds).toEqual({ a: 190, b: 190 });
    expect(bookOverroundBps(Object.values(odds))).toBeGreaterThanOrEqual(500);
  });
  it('spreads margin proportionally and clamps extremes', () => {
    const odds = priceSelections({ fav: 8000, dog: 2000 }, 500);
    expect(odds.fav).toBe(119);
    expect(odds.dog).toBe(470);
    expect(oddsFromProbability(1, 500)).toBe(MAX_ODDS);
    expect(oddsFromProbability(10_000, 500)).toBe(MIN_ODDS);
    expect(bookOverroundBps([odds.fav!, odds.dog!])).toBeGreaterThanOrEqual(500);
  });
});

describe('liability shading', () => {
  it('leaves balanced books alone', () => {
    const p = { a: 5000, b: 5000 };
    expect(applyLiabilityShading(p, { a: 1000, b: 900 }, 100_000)).toBe(p);
  });
  it('shortens the exposed selection and lengthens the rest', () => {
    const shaded = applyLiabilityShading({ a: 5000, b: 5000 }, { a: 100_000, b: -50_000 }, 100_000);
    expect(shaded.a).toBeGreaterThan(5000);
    expect(shaded.b).toBeLessThan(5000);
    expect(shaded.a! + shaded.b!).toBe(10_000);
    const odds = priceSelections(shaded, 500);
    expect(odds.a).toBeLessThan(190);
    expect(odds.b).toBeGreaterThan(190);
  });
});

describe('probability model', () => {
  it('normal CDF is accurate', () => {
    expect(P.normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(P.normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(P.normalCdf(-1)).toBeCloseTo(0.1587, 3);
  });

  it('resources are calibrated and monotonic', () => {
    expect(P.resources(50, 0)).toBeCloseTo(1, 6);
    expect(P.resources(20, 0)).toBeCloseTo(0.57, 1);
    expect(P.resources(10, 0)).toBeCloseTo(0.32, 1);
    for (let w = 0; w < 10; w += 1) expect(P.resources(20, w + 1)).toBeLessThan(P.resources(20, w));
    for (let u = 1; u <= 50; u += 1) expect(P.resources(u, 3)).toBeGreaterThan(P.resources(u - 1, 3));
    expect(P.resources(10, 10)).toBe(0);
    expect(P.resourceFraction(120, 0, 120)).toBeCloseTo(1, 6);
  });

  it('projects a par innings to par', () => {
    const start = P.projectedTotal({ runs: 0, wicketsLost: 0, ballsBowled: 0, allottedBalls: 120, par: 160 });
    expect(start.mean).toBeCloseTo(160, 0);
    expect(start.sd).toBeGreaterThan(20);
  });

  it('rewards fast starts and punishes collapses', () => {
    const base = { allottedBalls: 120, par: 160, ballsBowled: 36 };
    const flying = P.projectedTotal({ ...base, runs: 70, wicketsLost: 0 }).mean;
    const steady = P.projectedTotal({ ...base, runs: 45, wicketsLost: 1 }).mean;
    const collapse = P.projectedTotal({ ...base, runs: 30, wicketsLost: 5 }).mean;
    expect(flying).toBeGreaterThan(steady);
    expect(steady).toBeGreaterThan(collapse);
  });

  it('prices chases sensibly', () => {
    const s = { allottedBalls: 120, par: 160, ballsBowled: 60 };
    expect(P.chaseWinProb({ ...s, runs: 101, wicketsLost: 2, target: 101 })).toBe(1);
    expect(P.chaseWinProb({ ...s, runs: 100, wicketsLost: 2, target: 101 })).toBeGreaterThan(0.999);
    expect(P.chaseWinProb({ ...s, runs: 50, wicketsLost: 10, target: 160 })).toBe(0);
    const easy = P.chaseWinProb({ ...s, runs: 90, wicketsLost: 1, target: 150 });
    const hard = P.chaseWinProb({ ...s, runs: 50, wicketsLost: 6, target: 190 });
    expect(easy).toBeGreaterThan(0.75);
    expect(hard).toBeLessThan(0.1);
  });

  it('first-innings win probability rises with the projected total', () => {
    const inn = { wicketsLost: 2, ballsBowled: 60, allottedBalls: 120, par: 160 };
    expect(P.batFirstWinProb({ ...inn, runs: 100 }, 160)).toBeGreaterThan(P.batFirstWinProb({ ...inn, runs: 60 }, 160));
    expect(P.batFirstWinProb({ ...inn, runs: 80, ballsBowled: 120, wicketsLost: 10 }, 160)).toBeLessThan(0.05);
  });

  it('pre-match probabilities favour the stronger side and sum to one', () => {
    const p = P.preMatchProbs({ strengthA: 0.75, strengthB: 0.4, h2hA: 0.2, tossA: 1, format: 'T20' });
    expect(p.a).toBeGreaterThan(0.7);
    expect(p.a + p.b + p.draw).toBeCloseTo(1, 9);
    const t = P.preMatchProbs({ strengthA: 0.5, strengthB: 0.5, h2hA: 0, tossA: 0, format: 'TEST' });
    expect(t).toMatchObject({ draw: 0.25 });
    expect(t.a).toBeCloseTo(t.b, 9);
  });

  it('partnership and opening-stand maths', () => {
    expect(P.partnershipMean(160, 1)).toBeGreaterThan(P.partnershipMean(160, 9));
    expect(P.probExceeds(0, 20)).toBe(1);
    expect(P.probExceeds(20, 20)).toBeCloseTo(Math.exp(-1), 9);
    expect(P.openingStandProb(0, 20, 20)).toBeCloseTo(0.5, 9);
    expect(P.openingStandProb(40, 20, 20)).toBeGreaterThan(0.9);
  });

  it('lines sit on .5 near the mean', () => {
    expect(P.lineNear(145.7)).toBe(1455);
    expect(P.probOver(145.7, 20, 1455)).toBeCloseTo(0.504, 2);
    expect(P.toBps(0.12345)).toBe(1235);
  });

  it('dismissal buckets are proper distributions', () => {
    for (const t of ['PACE', 'SPIN', null] as const) {
      expect(Object.values(P.dismissalProbs(t)).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    }
  });
});
