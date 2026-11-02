import type { MatchFormat } from '../../../providers/cricket/types.js';
import { expectedRemaining, lineNear, probOver, projectedTotal, runsSd, type InningsState } from '../odds/probability.js';
import type { MarketSpec } from '../types.js';
import type { PricingContext } from './context.js';
import { battingTeamFor, ordinal, OVER_UNDER, teamName, twoWay, YES_NO, type MarketDefinition, type MarketLike } from './definition.js';

const SESSIONS: Record<MatchFormat, number[]> = { T10: [3, 6], T20: [6, 10, 15, 20], ODI: [10, 20, 30, 40, 50], TEST: [] };

/** Innings state now, or a fresh innings when it hasn't started. */
function stateFor(ctx: PricingContext, innings: number): InningsState | null {
  const team = battingTeamFor(ctx, innings);
  const inn = ctx.inningsOf(innings);
  if (inn) return ctx.stateOf(inn);
  return { runs: 0, wicketsLost: 0, ballsBowled: 0, allottedBalls: ctx.allottedBalls, par: team ? ctx.parFor(team) : ctx.facts.par };
}

/** Expected runs between now and the end of over `toBalls/6`, via the resources model. */
function runsBetween(s: InningsState, toBalls: number): number {
  if (toBalls <= s.ballsBowled) return 0;
  return expectedRemaining(s) - expectedRemaining({ ...s, ballsBowled: toBalls, runs: s.runs });
}

function inningsTotalMean(ctx: PricingContext, innings: number): { mean: number; sd: number } | null {
  const s = stateFor(ctx, innings);
  if (!s) return null;
  const proj = projectedTotal(s);
  const target = innings === 2 ? (ctx.inningsOf(2)?.target ?? (ctx.inningsOf(1) ? (ctx.inningsOf(1)?.runs ?? 0) + 1 : null)) : null;
  // A successful chase stops at the target, so its total can't run far past it.
  return target !== null ? { mean: Math.min(proj.mean, target + 3), sd: Math.min(proj.sd, Math.max(4, target + 3 - s.runs)) } : proj;
}

/** Can a market on innings n still be traded at all? */
function inningsOpen(ctx: PricingContext, innings: number): boolean {
  if (ctx.finished || !ctx.limitedOvers) return false;
  const inn = ctx.inningsOf(innings);
  if (inn?.isComplete) return false;
  // The second innings only becomes a market once the first is over.
  return innings === 1 || ctx.inningsOf(1)?.isComplete === true;
}

export const totalsDefinition: MarketDefinition = {
  types: ['INNINGS_TOTAL', 'SESSION_RUNS', 'NEXT_OVER_RUNS'],

  specs(ctx) {
    const out: MarketSpec[] = [];
    for (const n of [1, 2]) {
      if (!inningsOpen(ctx, n)) continue;
      const team = battingTeamFor(ctx, n);
      const label = team ? teamName(ctx, team) : `${ordinal(n)} Innings`;
      const total = inningsTotalMean(ctx, n);
      const s = stateFor(ctx, n);
      if (!total || !s) continue;
      out.push({
        key: `INNINGS_TOTAL:${n}`,
        type: 'INNINGS_TOTAL',
        name: `${label} Total Runs`,
        group: 'INNINGS',
        params: { innings: n, ...(team ? { teamKey: team } : {}) },
        inPlay: true,
        lineX10: lineNear(total.mean),
        selections: [...OVER_UNDER],
        sortOrder: 10 + n,
      });
      // Session and next-over markets settle from ball-by-ball data; without it they're never offered (A-16).
      const bbb = ctx.match.capabilities.ballByBall;
      for (const k of bbb ? SESSIONS[ctx.match.format].filter((o) => o * 6 <= s.allottedBalls) : []) {
        if (s.ballsBowled >= (k - 1) * 6) continue; // last over of the session already started
        out.push({
          key: `SESSION_RUNS:${n}:${k}`,
          type: 'SESSION_RUNS',
          name: `${label} Overs 1–${k} Runs`,
          group: 'SESSIONS',
          params: { innings: n, overs: k, ...(team ? { teamKey: team } : {}) },
          inPlay: true,
          lineX10: lineNear(s.runs + runsBetween(s, k * 6)),
          selections: [...YES_NO],
          sortOrder: 20 + n * 10 + k,
        });
      }
      // Next-over market: between overs of an innings in progress only.
      const inn = ctx.inningsOf(n);
      const last = ctx.lastBall;
      if (bbb && inn && team && inn.balls % 6 === 0 && inn.balls < s.allottedBalls && s.wicketsLost < 10) {
        const over = inn.balls / 6;
        const overStarted = last?.innings === n && last.over >= over;
        if (!overStarted) {
          out.push({
            key: `NEXT_OVER_RUNS:${n}:${over}`,
            type: 'NEXT_OVER_RUNS',
            name: `${teamName(ctx, team)} Over ${over + 1} Runs`,
            group: 'OVER',
            params: { innings: n, over, teamKey: team },
            inPlay: true,
            lineX10: lineNear(runsBetween(s, inn.balls + 6)),
            selections: [...OVER_UNDER],
            sortOrder: 5,
          });
        }
      }
    }
    return out;
  },

  price(m: MarketLike, ctx) {
    const n = m.params.innings ?? 1;
    const s = stateFor(ctx, n);
    if (!s || m.lineX10 === null) return null;
    if (m.type === 'INNINGS_TOTAL') {
      const t = inningsTotalMean(ctx, n);
      return t ? twoWay(probOver(t.mean, t.sd, m.lineX10)) : null;
    }
    if (m.type === 'SESSION_RUNS') {
      const end = (m.params.overs ?? 0) * 6;
      const mean = s.runs + runsBetween(s, end);
      return twoWay(probOver(mean, runsSd(Math.max(0, end - s.ballsBowled)), m.lineX10), ['yes', 'no']);
    }
    // NEXT_OVER_RUNS: runs in over `over` only.
    const start = (m.params.over ?? 0) * 6;
    const mean = runsBetween({ ...s, ballsBowled: Math.max(s.ballsBowled, start) }, start + 6);
    return twoWay(probOver(mean, runsSd(6), m.lineX10));
  },

  shouldClose(m, ctx) {
    const n = m.params.innings ?? 1;
    const inn = ctx.inningsOf(n);
    if (ctx.finished || inn?.isComplete) return true;
    if (!inn || m.lineX10 === null) return false;
    if (m.type === 'NEXT_OVER_RUNS') {
      const over = m.params.over ?? 0;
      const last = ctx.lastBall;
      return inn.balls > over * 6 || (last?.innings === n && last.over >= over);
    }
    if (m.type === 'SESSION_RUNS' && inn.balls >= ((m.params.overs ?? 0) - 1) * 6) return true;
    // Line already passed: the "over"/"yes" side has won, nothing left to price.
    return inn.runs * 10 > m.lineX10;
  },
};

