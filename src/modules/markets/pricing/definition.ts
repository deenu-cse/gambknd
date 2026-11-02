import type { ISelection } from '../market.model.js';
import type { AutoMarketType, MarketParams, MarketSpec, MarketStatus } from '../types.js';
import type { PricingContext } from './context.js';

/** The slice of a stored market a definition needs. */
export interface MarketLike {
  key: string;
  type: AutoMarketType;
  params: MarketParams;
  selections: Array<Pick<ISelection, 'id' | 'teamKey' | 'playerId' | 'status'>>;
  lineX10: number | null;
  status: MarketStatus;
  inPlay: boolean;
}

/**
 * One market family. `specs` says which markets should exist right now (called on every match
 * change; keys make it idempotent). `price` returns fair probabilities (0–1) per selection id,
 * or null if it can't price. `shouldClose` says betting must stop for good.
 */
export interface MarketDefinition {
  types: readonly AutoMarketType[];
  specs(ctx: PricingContext): MarketSpec[];
  price(m: MarketLike, ctx: PricingContext): Record<string, number> | null;
  shouldClose(m: MarketLike, ctx: PricingContext): boolean;
}

export function teamName(ctx: PricingContext, key: string | null | undefined): string {
  return ctx.match.teams.find((t) => t.key === key)?.name ?? 'Team';
}

export function otherTeam(ctx: PricingContext, key: string): string {
  return ctx.match.teams.find((t) => t.key !== key)?.key ?? key;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export const OVER_UNDER = [
  { id: 'over', name: 'Over' },
  { id: 'under', name: 'Under' },
] as const;

export const YES_NO = [
  { id: 'yes', name: 'Yes' },
  { id: 'no', name: 'No' },
] as const;

export function lineText(lineX10: number): string {
  return (lineX10 / 10).toFixed(1);
}

/** Two-way line market: P(over) → { over, under } (or { yes, no }). */
export function twoWay(pOver: number, ids: readonly [string, string] = ['over', 'under']): Record<string, number> {
  return { [ids[0]]: pOver, [ids[1]]: 1 - pOver };
}

/** Which batting team an innings number belongs to, when known. */
export function battingTeamFor(ctx: PricingContext, innings: number): string | null {
  const inn = ctx.inningsOf(innings);
  if (inn) return inn.battingTeamKey;
  if (!ctx.battingFirst) return null;
  return innings % 2 === 1 ? ctx.battingFirst : otherTeam(ctx, ctx.battingFirst);
}
