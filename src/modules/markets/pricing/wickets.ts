import { dismissalProbs, expectedRemaining, lineNear, partnershipMean, probExceeds } from '../odds/probability.js';
import type { MarketSpec } from '../types.js';
import type { PricingContext } from './context.js';
import { ordinal, OVER_UNDER, teamName, twoWay, type MarketDefinition, type MarketLike } from './definition.js';

const METHODS = [
  { id: 'CAUGHT', name: 'Caught' },
  { id: 'BOWLED', name: 'Bowled' },
  { id: 'LBW', name: 'LBW' },
  { id: 'RUN_OUT', name: 'Run Out' },
  { id: 'OTHER', name: 'Other (stumped, hit wicket…)' },
];

/** Expected further runs before the next wicket: the partnership mean, capped by what's left of the innings. */
function partnershipLeft(ctx: PricingContext, innings: number, wicket: number): number {
  const inn = ctx.inningsOf(innings);
  if (!inn) return 0;
  const s = ctx.stateOf(inn);
  return Math.max(1, Math.min(partnershipMean(s.par, wicket), expectedRemaining(s)));
}

function bowlerType(ctx: PricingContext): 'PACE' | 'SPIN' | null {
  const id = ctx.lastBall?.bowlerId;
  if (!id) return null;
  for (const squad of Object.values(ctx.squads)) {
    const p = squad.find((x) => x.playerId === id);
    if (p) return p.bowlingType;
  }
  return null;
}

export const wicketsDefinition: MarketDefinition = {
  types: ['FALL_OF_NEXT_WICKET', 'DISMISSAL_METHOD'],

  specs(ctx) {
    const inn = ctx.current();
    // Dismissal method needs ball-by-ball to settle; never offer what we can't settle (A-16).
    if (!inn || ctx.finished || !ctx.limitedOvers || inn.wickets >= 10 || !ctx.match.capabilities.ballByBall) return [];
    const n = inn.number;
    const w = inn.wickets + 1;
    const team = teamName(ctx, inn.battingTeamKey);
    const mean = partnershipLeft(ctx, n, w);
    return [
      {
        key: `FALL_OF_NEXT_WICKET:${n}:${w}`,
        type: 'FALL_OF_NEXT_WICKET',
        name: `${team} Fall of ${ordinal(w)} Wicket (runs)`,
        group: 'WICKETS',
        params: { innings: n, wicket: w, teamKey: inn.battingTeamKey },
        inPlay: true,
        // Median of runs + Exp(mean) is runs + mean·ln2.
        lineX10: lineNear(inn.runs + mean * Math.LN2),
        selections: [...OVER_UNDER],
        sortOrder: 40,
      },
      {
        key: `DISMISSAL_METHOD:${n}:${w}`,
        type: 'DISMISSAL_METHOD',
        name: `${team} Method of ${ordinal(w)} Dismissal`,
        group: 'WICKETS',
        params: { innings: n, wicket: w, teamKey: inn.battingTeamKey },
        inPlay: true,
        lineX10: null,
        selections: METHODS,
        sortOrder: 41,
      },
    ] satisfies MarketSpec[];
  },

  price(m: MarketLike, ctx) {
    const n = m.params.innings ?? 1;
    const inn = ctx.inningsOf(n);
    if (!inn) return null;
    if (m.type === 'DISMISSAL_METHOD') return dismissalProbs(bowlerType(ctx));
    if (m.lineX10 === null) return null;
    const mean = partnershipLeft(ctx, n, m.params.wicket ?? 1);
    return twoWay(probExceeds(m.lineX10 / 10 - inn.runs, mean));
  },

  shouldClose(m, ctx) {
    const inn = ctx.inningsOf(m.params.innings ?? 1);
    if (ctx.finished || inn?.isComplete) return true;
    if (!inn) return false;
    if (inn.wickets >= (m.params.wicket ?? 1)) return true;
    return m.type === 'FALL_OF_NEXT_WICKET' && m.lineX10 !== null && inn.runs * 10 > m.lineX10;
  },
};
