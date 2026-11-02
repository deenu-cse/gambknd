import { MAX_ODDS, MIN_ODDS, toLadder } from './ladder.js';

export const BPS = 10_000;

/** Rescales probabilities (any positive weights) so they sum to exactly 10,000 bps. */
export function normalizeBps(probs: Record<string, number>): Record<string, number> {
  const entries = Object.entries(probs).map(([k, v]) => [k, Math.max(0, Number.isFinite(v) ? v : 0)] as const);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return Object.fromEntries(entries.map(([k]) => [k, Math.floor(BPS / entries.length)]));
  const scaled = entries.map(([k, v]) => [k, Math.floor((v * BPS) / total)] as [string, number]);
  // Largest-remainder fix so the integers sum to exactly 10,000.
  let short = BPS - scaled.reduce((s, [, v]) => s + v, 0);
  const order = entries.map(([, v], i) => ({ i, rem: (v * BPS) / total - (scaled[i]?.[1] ?? 0) })).sort((a, b) => b.rem - a.rem);
  for (const { i } of order) {
    if (short <= 0) break;
    (scaled[i] as [string, number])[1] += 1;
    short -= 1;
  }
  return Object.fromEntries(scaled);
}

/**
 * Fair probability → offered odds with an overround. The margin is spread proportionally:
 * implied probability_i = p_i × (1 + m), so Σ implied = 1 + m. Odds are then rounded DOWN
 * to the ladder (which only ever adds margin) and clamped to 1.01–100.
 * All inputs/outputs are integers: probability in bps, margin in bps, odds ×100.
 */
export function oddsFromProbability(probabilityBps: number, marginBps: number): number {
  if (probabilityBps <= 0) return MAX_ODDS;
  // odds×100 = 100 / (p × (1+m)) = 100 × 10⁴ × 10⁴ / (pBps × (10⁴ + mBps))
  const raw = (100 * BPS * BPS) / (probabilityBps * (BPS + marginBps));
  return Math.min(MAX_ODDS, Math.max(MIN_ODDS, toLadder(raw, 'down')));
}

export function priceSelections(fairBps: Record<string, number>, marginBps: number): Record<string, number> {
  return Object.fromEntries(Object.entries(fairBps).map(([id, p]) => [id, oddsFromProbability(p, marginBps)]));
}

/** Σ(1/odds) − 1, in bps: the book's actual overround after ladder rounding. */
export function bookOverroundBps(odds: readonly number[]): number {
  const implied = odds.reduce((s, o) => s + (100 * BPS) / o, 0);
  return Math.round(implied - BPS);
}
