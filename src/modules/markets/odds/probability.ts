/**
 * Pure cricket probability model. No I/O; every function is deterministic and unit-tested.
 * Outputs that leave this module are integer basis points (0–10,000). Internals use floats:
 * probabilities are not money, and the ledger never sees them.
 */

export const BPS = 10_000;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const toBps = (p: number): number => Math.round(clamp(p, 0, 1) * BPS);

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// ── Resources (simplified Duckworth–Lewis) ──────────────────────────────────
// Z(u, w) = F(w) · (1 − e^(−b·u / F(w))), u = overs left, w = wickets lost.
// b is calibrated so R(20 overs, 0 wkts) ≈ 57% and R(10, 0) ≈ 32% of a full 50-over innings.
const DECAY = 0.0275;
const WICKET_FACTOR = [1.0, 0.9, 0.8, 0.69, 0.57, 0.45, 0.34, 0.24, 0.15, 0.07, 0];
const FULL = 1 - Math.exp(-DECAY * 50);

/** Share of a full 50-over, 10-wicket innings' scoring resources still available. */
export function resources(oversLeft: number, wicketsLost: number): number {
  const f = WICKET_FACTOR[clamp(Math.trunc(wicketsLost), 0, 10)] ?? 0;
  if (f === 0 || oversLeft <= 0) return 0;
  return (f * (1 - Math.exp((-DECAY * Math.min(50, oversLeft)) / f))) / FULL;
}

/** Resources left as a share of THIS innings' starting resources (e.g. a 20-over innings). */
export function resourceFraction(ballsLeft: number, wicketsLost: number, allottedBalls: number): number {
  const start = resources(allottedBalls / 6, 0);
  return start > 0 ? resources(ballsLeft / 6, wicketsLost) / start : 0;
}

/** Spread of runs over `balls` deliveries; widens over long horizons (wickets cluster). */
export function runsSd(balls: number): number {
  if (balls <= 0) return 0.5;
  return Math.sqrt(balls) * (1.6 + 0.7 * Math.min(1, balls / 60));
}

export interface InningsState {
  runs: number;
  wicketsLost: number;
  ballsBowled: number;
  allottedBalls: number;
  /** Expected full-innings total for this batting side (venue/series par × strength). */
  par: number;
}

/**
 * Expected runs still to come. Resources say how much of the par is left; the current run rate
 * nudges it, more as the innings matures (a side 60/0 after 5 overs is going faster than par).
 */
export function expectedRemaining(s: InningsState): number {
  const ballsLeft = Math.max(0, s.allottedBalls - s.ballsBowled);
  if (ballsLeft === 0 || s.wicketsLost >= 10) return 0;
  const base = s.par * resourceFraction(ballsLeft, s.wicketsLost, s.allottedBalls);
  if (s.ballsBowled < 6) return base;
  const progress = s.ballsBowled / s.allottedBalls;
  // Runs par says should be on the board by now (wicket-neutral), to measure tempo against.
  const parUsed = s.par * (1 - resourceFraction(ballsLeft, 0, s.allottedBalls));
  const tempo = parUsed > 0 ? clamp(s.runs / parUsed, 0.5, 1.8) : 1;
  return base * (1 + 0.6 * progress * (tempo - 1));
}

export function projectedTotal(s: InningsState): { mean: number; sd: number } {
  const ballsLeft = Math.max(0, s.allottedBalls - s.ballsBowled);
  return { mean: s.runs + expectedRemaining(s), sd: runsSd(ballsLeft) };
}

/** P(X > line) for X ~ Normal(mean, sd). Lines are always x.5, so no continuity fudge needed. */
export function probOver(mean: number, sd: number, lineX10: number): number {
  return 1 - normalCdf((lineX10 / 10 - mean) / Math.max(0.5, sd));
}

/** A fixed .5 line near the median so the market opens close to evens. */
export function lineNear(mean: number): number {
  return Math.max(5, Math.floor(mean) * 10 + 5);
}

/** Chasing side's win probability: can the remaining resources produce `need` runs? */
export function chaseWinProb(s: InningsState & { target: number }): number {
  const need = s.target - s.runs;
  if (need <= 0) return 1;
  const ballsLeft = s.allottedBalls - s.ballsBowled;
  if (ballsLeft <= 0 || s.wicketsLost >= 10) return 0;
  const mean = expectedRemaining(s);
  return 1 - normalCdf((need - 0.5 - mean) / runsSd(ballsLeft));
}

/** First innings in progress (or just ended): P(side batting first wins). */
export function batFirstWinProb(first: InningsState, chasePar: number): number {
  const proj = projectedTotal(first);
  const fullSd = runsSd(first.allottedBalls);
  // Chasers win if their total reaches proj + 1. Combine both uncertainties.
  return normalCdf((proj.mean + 0.5 - chasePar) / Math.sqrt(proj.sd ** 2 + fullSd ** 2));
}

export interface StrengthInputs {
  /** Smoothed recent win rate, 0..1 (0.5 = unknown/average). */
  strengthA: number;
  strengthB: number;
  /** Head-to-head edge for A in −1..1. */
  h2hA: number;
  /** +1 if A won the toss, −1 if B did, 0 unknown. */
  tossA: number;
  format: 'T10' | 'T20' | 'ODI' | 'TEST';
}

/** Pre-match probabilities. Tests are 3-way with a draw. */
export function preMatchProbs(i: StrengthInputs): { a: number; b: number; draw: number } {
  const tossEdge = i.format === 'TEST' ? 0.02 : 0.015;
  const pa = clamp(0.5 + 0.8 * (i.strengthA - i.strengthB) + 0.1 * i.h2hA + tossEdge * i.tossA, 0.08, 0.92);
  if (i.format !== 'TEST') return { a: pa, b: 1 - pa, draw: 0 };
  const draw = 0.25;
  return { a: pa * (1 - draw), b: (1 - pa) * (1 - draw), draw };
}

/** Par for a specific side: strength 0.5 = par, 0 → 85%, 1 → 115%. */
export function sidePar(par: number, strength: number): number {
  return par * (0.85 + 0.3 * clamp(strength, 0, 1));
}

/** Average partnership for each wicket, as a share of par/8 (openers bat longest). */
const PARTNERSHIP_WEIGHT = [1.3, 1.2, 1.15, 1.05, 1.0, 0.85, 0.75, 0.6, 0.45, 0.35];
export function partnershipMean(par: number, wicketNumber: number): number {
  return (par / 8) * (PARTNERSHIP_WEIGHT[clamp(wicketNumber, 1, 10) - 1] ?? 0.5);
}

/** Partnerships are roughly exponential: P(more than x more runs) = e^(−x/μ). Memoryless. */
export function probExceeds(x: number, mean: number): number {
  if (x < 0) return 1;
  return Math.exp(-x / Math.max(1, mean));
}

/** P(A's opening stand > B's) when A is at `pA` and still batting, B yet to bat. */
export function openingStandProb(pA: number, meanA: number, meanB: number): number {
  return 1 - Math.exp(-pA / meanB) * (meanB / (meanA + meanB));
}

export type DismissalBucket = 'CAUGHT' | 'BOWLED' | 'LBW' | 'RUN_OUT' | 'OTHER';
export function dismissalProbs(bowlingType: 'PACE' | 'SPIN' | null): Record<DismissalBucket, number> {
  if (bowlingType === 'SPIN') return { CAUGHT: 0.5, BOWLED: 0.17, LBW: 0.16, RUN_OUT: 0.06, OTHER: 0.11 };
  if (bowlingType === 'PACE') return { CAUGHT: 0.55, BOWLED: 0.21, LBW: 0.12, RUN_OUT: 0.07, OTHER: 0.05 };
  return { CAUGHT: 0.53, BOWLED: 0.19, LBW: 0.14, RUN_OUT: 0.07, OTHER: 0.07 };
}

/** Expected innings for a batter from career average, with role defaults when unknown. */
export function batterMean(average100: number | null, role: string): number {
  if (average100 && average100 > 0) return clamp(average100 / 100, 3, 60);
  switch (role) {
    case 'BATTER': return 22;
    case 'WK_BATTER': return 19;
    case 'BAT_ALLROUNDER': return 16;
    case 'BOWL_ALLROUNDER': return 11;
    case 'BOWLER': return 6;
    default: return 12;
  }
}
