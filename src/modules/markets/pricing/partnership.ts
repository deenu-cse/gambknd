import { openingStandProb, partnershipMean, probExceeds } from '../odds/probability.js';
import type { PricingContext } from './context.js';
import { otherTeam, type MarketDefinition } from './definition.js';

interface Stand {
  /** Final opening stand, once the first wicket fell or the innings ended. */
  final: number | null;
  /** Current unbroken stand (0 before the innings starts). */
  current: number;
}

function standOf(ctx: PricingContext, innings: number): Stand {
  const inn = ctx.inningsOf(innings);
  if (!inn) return { final: null, current: 0 };
  const first = inn.fallOfWickets[0];
  if (first) return { final: first.runs, current: first.runs };
  return inn.isComplete ? { final: inn.runs, current: inn.runs } : { final: null, current: inn.runs };
}

/** P(side batting first has the higher opening stand). Ties are a dead heat (MARKET_RULES). */
export function openingProbs(ctx: PricingContext): { batFirst: string; p: number; decided: boolean } {
  const batFirst = ctx.battingFirst ?? ctx.match.teams[0].key;
  const chaser = otherTeam(ctx, batFirst);
  const muA = partnershipMean(ctx.parFor(batFirst), 1);
  const muB = partnershipMean(ctx.parFor(chaser), 1);
  const a = standOf(ctx, 1);
  const b = standOf(ctx, 2);
  if (a.final === null) return { batFirst, p: openingStandProb(a.current, muA, muB), decided: false };
  if (b.final !== null) return { batFirst, p: a.final > b.final ? 1 : a.final < b.final ? 0 : 0.5, decided: true };
  if (b.current > a.final) return { batFirst, p: 0, decided: true };
  return { batFirst, p: 1 - probExceeds(a.final - b.current, muB), decided: false };
}

export const partnershipDefinition: MarketDefinition = {
  types: ['OPENING_PARTNERSHIP'],

  specs(ctx) {
    if (ctx.finished || !ctx.limitedOvers || ctx.inningsOf(1)) return [];
    const [a, b] = ctx.match.teams;
    if (a.key === 'tbc' || b.key === 'tbc') return [];
    return [
      {
        key: 'OPENING_PARTNERSHIP', type: 'OPENING_PARTNERSHIP', name: 'Highest Opening Partnership', group: 'SPECIALS',
        params: {}, inPlay: true, lineX10: null, sortOrder: 70,
        selections: [{ id: a.key, name: a.name, teamKey: a.key }, { id: b.key, name: b.name, teamKey: b.key }],
      },
    ];
  },

  price(_m, ctx) {
    const { batFirst, p, decided } = openingProbs(ctx);
    if (decided) return null;
    return { [batFirst]: p, [otherTeam(ctx, batFirst)]: 1 - p };
  },

  shouldClose(_m, ctx) {
    return ctx.finished || openingProbs(ctx).decided;
  },
};
