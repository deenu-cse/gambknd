import { assertPositiveUnits, mulDiv } from '../../utils/money.js';

/** Odds are ×100 integers. Accumulator prices are capped so one bet can't produce an absurd liability. */
export const MAX_ACCA_ODDS = 100_000; // 1000.00
export const MAX_ACCA_LEGS = 10;

/** Π(odds_i) for ×100 integers, rounded down: floor(Π odds_i / 100^(n−1)). */
export function comboOdds(odds: readonly number[]): number {
  if (odds.length === 0) throw new RangeError('no legs');
  let num = 1n;
  for (const o of odds) {
    if (!Number.isSafeInteger(o) || o < 100) throw new RangeError(`invalid odds ${o}`);
    num *= BigInt(o);
  }
  const combined = num / 100n ** BigInt(odds.length - 1);
  return Number(combined > BigInt(MAX_ACCA_ODDS) ? BigInt(MAX_ACCA_ODDS) : combined);
}

/** Total returned on a win (stake included): floor(stake × odds / 100). */
export function potentialReturn(stake: number, odds: number): number {
  assertPositiveUnits(stake, 'stake');
  return mulDiv(stake, odds, 100);
}

/**
 * Cash-out value for an open single: what the bet is worth at today's price, minus a margin.
 *   offer = stake × placedOdds / currentOdds × (1 − margin)
 * Never more than the full potential return − 1 (it's still a bet), never below 1 unit.
 */
export function cashoutOffer(stake: number, placedOdds: number, currentOdds: number, marginBps: number): number {
  const fair = mulDiv(stake, placedOdds, currentOdds);
  const offer = mulDiv(fair, 10_000 - marginBps, 10_000);
  return Math.max(1, Math.min(offer, potentialReturn(stake, placedOdds) - 1));
}

export type LegOutcome = 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'DEAD_HEAT';

export interface LegResult {
  outcome: LegOutcome;
  odds: number;
  /** Dead heat between N selections: the leg pays 1/N of its odds. */
  deadHeatWays?: number;
}

export interface BetOutcome {
  status: 'PENDING' | 'WON' | 'LOST' | 'VOID';
  /** Effective odds after removing void legs and applying dead heats (×100). */
  effectiveOdds: number;
  payout: number;
}

/**
 * Settles a single or an accumulator from its legs (MARKET_RULES):
 *  - any LOST leg → the bet loses (even if others are still pending);
 *  - VOID legs drop out and the odds are recalculated; all legs void → stake refunded;
 *  - a dead-heat leg contributes odds / ways (e.g. two-way dead heat at 3.00 → 1.50);
 *  - otherwise pending until every leg is decided.
 */
export function settleLegs(stake: number, legs: readonly LegResult[]): BetOutcome {
  if (legs.some((l) => l.outcome === 'LOST')) return { status: 'LOST', effectiveOdds: 0, payout: 0 };
  if (legs.some((l) => l.outcome === 'PENDING')) return { status: 'PENDING', effectiveOdds: 0, payout: 0 };
  const live = legs.filter((l) => l.outcome !== 'VOID');
  if (live.length === 0) return { status: 'VOID', effectiveOdds: 100, payout: stake };

  // Work in a common ×100 scale; a dead heat of N ways divides that leg's odds by N.
  let num = BigInt(stake);
  let den = 1n;
  for (const l of live) {
    num *= BigInt(l.odds);
    den *= 100n * BigInt(l.outcome === 'DEAD_HEAT' ? Math.max(1, l.deadHeatWays ?? 2) : 1);
  }
  const payout = Number(num / den);
  const effectiveOdds = Number((num * 100n) / (den * BigInt(stake)));
  return { status: 'WON', effectiveOdds: Math.min(effectiveOdds, MAX_ACCA_ODDS), payout };
}
