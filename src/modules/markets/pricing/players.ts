import { batterMean, expectedRemaining, lineNear, probExceeds } from '../odds/probability.js';
import type { MarketSpec } from '../types.js';
import type { PlayerForm, PricingContext } from './context.js';
import { OVER_UNDER, teamName, twoWay, type MarketDefinition, type MarketLike } from './definition.js';

const MAX_CANDIDATES = 12;
const ROLE_BAT_FACTOR: Record<string, number> = { BATTER: 1.2, WK_BATTER: 1.1, BAT_ALLROUNDER: 1.0, UNKNOWN: 0.8, BOWL_ALLROUNDER: 0.6, BOWLER: 0.35 };
const ROLE_BOWL_BASE: Record<string, number> = { BOWLER: 1.0, BOWL_ALLROUNDER: 0.75, BAT_ALLROUNDER: 0.45, UNKNOWN: 0.2 };

function battingWeight(p: PlayerForm): number {
  const mean = batterMean(p.battingAverage100, p.role);
  const sr = p.strikeRate100 ? p.strikeRate100 / 12_000 : 1;
  return mean ** 1.3 * (ROLE_BAT_FACTOR[p.role] ?? 0.8) * Math.min(1.4, Math.max(0.7, sr));
}

function bowlingWeight(p: PlayerForm): number | null {
  const base = ROLE_BOWL_BASE[p.role];
  if (base === undefined && !p.bowlingType) return null;
  const perMatch = p.wickets !== null && p.bowlingMatches ? p.wickets / p.bowlingMatches : null;
  return (perMatch ?? base ?? 0.3) + 0.3;
}

function topCandidates(players: PlayerForm[], weight: (p: PlayerForm) => number | null): Array<{ p: PlayerForm; w: number }> {
  return players
    .map((p) => ({ p, w: weight(p) }))
    .filter((x): x is { p: PlayerForm; w: number } => x.w !== null && x.w > 0)
    .sort((a, b) => b.w - a.w)
    .slice(0, MAX_CANDIDATES);
}

const preMatch = (ctx: PricingContext): boolean => ctx.match.status === 'UPCOMING' || ctx.match.status === 'TOSS';

/** Player-runs markets are offered for the top three in each batting order once they're at the crease. */
const TOP_ORDER = 3;

function playerMean(ctx: PricingContext, innings: number, playerId: string): number {
  const inn = ctx.inningsOf(innings);
  const form = Object.values(ctx.squads).flat().find((p) => p.playerId === playerId);
  const career = batterMean(form?.battingAverage100 ?? null, form?.role ?? 'BATTER');
  // A batter can't score more than a share of what's left in the innings.
  const cap = inn ? expectedRemaining(ctx.stateOf(inn)) * 0.45 : career;
  return Math.max(1, Math.min(career, cap));
}

export const playersDefinition: MarketDefinition = {
  types: ['TOP_BATSMAN', 'TOP_BOWLER', 'PLAYER_RUNS'],

  specs(ctx) {
    const out: MarketSpec[] = [];
    if (preMatch(ctx) && ctx.limitedOvers) {
      for (const team of ctx.match.teams) {
        const squad = ctx.squads[team.key] ?? [];
        if (squad.length < 5) continue;
        const bats = topCandidates(squad, battingWeight);
        const bowls = topCandidates(squad, bowlingWeight);
        if (bats.length >= 2) {
          out.push({
            key: `TOP_BATSMAN:${team.key}`, type: 'TOP_BATSMAN', name: `Top Batsman — ${team.name}`, group: 'PLAYERS',
            params: { teamKey: team.key }, inPlay: false, lineX10: null, sortOrder: 60,
            selections: bats.map(({ p }) => ({ id: p.playerId, name: p.name, playerId: p.playerId, teamKey: team.key })),
          });
        }
        if (bowls.length >= 2) {
          out.push({
            key: `TOP_BOWLER:${team.key}`, type: 'TOP_BOWLER', name: `Top Bowler — ${team.name}`, group: 'PLAYERS',
            params: { teamKey: team.key }, inPlay: false, lineX10: null, sortOrder: 61,
            selections: bowls.map(({ p }) => ({ id: p.playerId, name: p.name, playerId: p.playerId, teamKey: team.key })),
          });
        }
      }
    }
    const inn = ctx.current();
    // Player runs settle from the scorecard (batting lines); require it.
    if (inn && !ctx.finished && ctx.limitedOvers && ctx.match.capabilities.scorecard) {
      inn.batting.slice(0, TOP_ORDER).filter((b) => !b.isOut).forEach((b) => {
        const mean = playerMean(ctx, inn.number, b.playerId);
        out.push({
          key: `PLAYER_RUNS:${inn.number}:${b.playerId}`, type: 'PLAYER_RUNS', name: `${b.name} Runs (${teamName(ctx, inn.battingTeamKey)})`,
          group: 'PLAYERS', params: { innings: inn.number, playerId: b.playerId, teamKey: inn.battingTeamKey }, inPlay: true,
          lineX10: lineNear(b.runs + mean * Math.LN2), selections: [...OVER_UNDER], sortOrder: 50,
        });
      });
    }
    return out;
  },

  price(m: MarketLike, ctx) {
    if (m.type === 'PLAYER_RUNS') {
      const n = m.params.innings ?? 1;
      const line = ctx.inningsOf(n)?.batting.find((b) => b.playerId === m.params.playerId);
      if (!line || m.lineX10 === null) return null;
      return twoWay(probExceeds(m.lineX10 / 10 - line.runs, playerMean(ctx, n, line.playerId)));
    }
    const squad = ctx.squads[m.params.teamKey ?? ''] ?? [];
    const weigh = m.type === 'TOP_BATSMAN' ? battingWeight : bowlingWeight;
    const ids = new Set(m.selections.filter((s) => s.status === 'ACTIVE').map((s) => s.id));
    const weights = squad.filter((p) => ids.has(p.playerId)).map((p) => [p.playerId, weigh(p) ?? 0.1] as const);
    return weights.length >= 2 ? Object.fromEntries(weights) : null;
  },

  shouldClose(m, ctx) {
    if (ctx.finished) return true;
    if (m.type !== 'PLAYER_RUNS') return !preMatch(ctx);
    const inn = ctx.inningsOf(m.params.innings ?? 1);
    if (!inn || inn.isComplete) return !!inn;
    const line = inn.batting.find((b) => b.playerId === m.params.playerId);
    return !line || line.isOut || (m.lineX10 !== null && line.runs * 10 > m.lineX10);
  },
};
