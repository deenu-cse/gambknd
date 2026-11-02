import { batFirstWinProb, chaseWinProb, preMatchProbs } from '../odds/probability.js';
import type { MarketSpec } from '../types.js';
import type { PricingContext } from './context.js';
import { otherTeam, type MarketDefinition } from './definition.js';

/** P(teams[0] wins) etc. Exported: the engine uses it for the scoreboard win-probability bar. */
export function matchWinnerProbs(ctx: PricingContext): Record<string, number> | null {
  if (ctx.finished) return null;
  const [a, b] = ctx.match.teams;
  const toss = ctx.match.toss;
  const pre = preMatchProbs({
    strengthA: ctx.facts.strength[a.key] ?? 0.5,
    strengthB: ctx.facts.strength[b.key] ?? 0.5,
    h2hA: ctx.facts.h2h,
    tossA: toss ? (toss.winnerKey === a.key ? 1 : -1) : 0,
    format: ctx.match.format,
  });
  if (ctx.match.format === 'TEST' || !ctx.limitedOvers) return { [a.key]: pre.a, [b.key]: pre.b, ...(pre.draw > 0 ? { draw: pre.draw } : {}) };

  const inn1 = ctx.inningsOf(1);
  const inn2 = ctx.inningsOf(2);
  let pBatFirst: number;
  let batFirst: string;
  if (inn2 || inn1?.isComplete) {
    const first = inn1!;
    batFirst = first.battingTeamKey;
    const chaser = otherTeam(ctx, batFirst);
    const target = inn2?.target ?? first.runs + 1;
    const state = inn2 ? ctx.stateOf(inn2) : { runs: 0, wicketsLost: 0, ballsBowled: 0, allottedBalls: ctx.allottedBalls, par: ctx.parFor(chaser) };
    pBatFirst = 1 - chaseWinProb({ ...state, target });
  } else if (inn1) {
    batFirst = inn1.battingTeamKey;
    const model = batFirstWinProb(ctx.stateOf(inn1), ctx.parFor(otherTeam(ctx, batFirst)));
    const prior = batFirst === a.key ? pre.a : pre.b;
    // Lean on the prior early, on the scoreboard as the innings matures.
    const w = 0.3 + 0.7 * Math.min(1, inn1.balls / ctx.allottedBalls);
    pBatFirst = (1 - w) * prior + w * model;
  } else {
    return { [a.key]: pre.a, [b.key]: pre.b };
  }
  const pA = batFirst === a.key ? pBatFirst : 1 - pBatFirst;
  return { [a.key]: pA, [b.key]: 1 - pA };
}

export const matchWinnerDefinition: MarketDefinition = {
  types: ['MATCH_WINNER', 'TOSS_WINNER'],

  specs(ctx) {
    const [a, b] = ctx.match.teams;
    if (ctx.finished || a.key === 'tbc' || b.key === 'tbc') return [];
    const teams = [
      { id: a.key, name: a.name, teamKey: a.key },
      { id: b.key, name: b.name, teamKey: b.key },
    ];
    const out: MarketSpec[] = [
      {
        key: 'MATCH_WINNER',
        type: 'MATCH_WINNER',
        name: 'Match Winner',
        group: 'MAIN',
        params: {},
        inPlay: true,
        lineX10: null,
        selections: ctx.match.format === 'TEST' ? [...teams, { id: 'draw', name: 'Draw' }] : teams,
        sortOrder: 1,
      },
    ];
    if (ctx.match.status === 'UPCOMING' && !ctx.match.toss) {
      out.push({ key: 'TOSS_WINNER', type: 'TOSS_WINNER', name: 'Toss Winner', group: 'MAIN', params: {}, inPlay: false, lineX10: null, selections: teams, sortOrder: 2 });
    }
    return out;
  },

  price(m, ctx) {
    if (m.type === 'TOSS_WINNER') return Object.fromEntries(m.selections.map((s) => [s.id, 0.5]));
    return matchWinnerProbs(ctx);
  },

  shouldClose(m, ctx) {
    if (m.type === 'TOSS_WINNER') return ctx.match.toss !== null || ctx.match.status !== 'UPCOMING';
    return ctx.finished;
  },
};
