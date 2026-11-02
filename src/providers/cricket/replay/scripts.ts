import currentMatches from '../fixtures/currentMatches.json' with { type: 'json' };
import seriesInfo from '../fixtures/seriesInfo.json' with { type: 'json' };
import seriesSquad from '../fixtures/seriesSquad.json' with { type: 'json' };
import { rawMatchSchema, rawSquadSchema } from '../live/schemas.js';
import { normalizeMatch } from '../normalizers/match.js';
import { normalizeSquad } from '../normalizers/player.js';
import { STANDARD_OVERS } from '../normalizers/text.js';
import type { MatchFormat, MatchResult, SquadPlayer, TeamRef, Toss, Venue } from '../types.js';
import { Rng } from './rng.js';
import { placeholderSquad } from './squads.js';

export interface InningsPlan {
  battingKey: string;
  bowlingKey: string;
  runs: number;
  wickets: number;
  balls: number;
  /** Chase target in force (DLS: the chasing side's final score, A-19). null for the first innings. */
  target: number | null;
}

export interface ReplayScript {
  id: string;
  sourceProviderId: string;
  title: string;
  matchLabel: string | null;
  seriesName: string | null;
  format: MatchFormat;
  scheduledOvers: number;
  venue: Venue | null;
  teams: [TeamRef, TeamRef];
  toss: Toss;
  plan: [InningsPlan, InningsPlan];
  result: MatchResult;
  resultText: string;
  squads: Record<string, SquadPlayer[]>;
  /** true when the real data only had a result line and the innings totals were synthesized. */
  scoreSynthesized: boolean;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function squadMap(teams: readonly TeamRef[], captured: Map<string, SquadPlayer[]>): Record<string, SquadPlayer[]> {
  return Object.fromEntries(teams.map((t) => [t.key, captured.get(t.key) ?? placeholderSquad(t)]));
}

function synthToss(rng: Rng, teams: readonly TeamRef[], battingFirstKey: string): Toss {
  const winner = rng.pick(teams);
  return { winnerKey: winner.key, decision: winner.key === battingFirstKey ? 'BAT' : 'BOWL' };
}

/** Totals for a match where only the result line is known ("X won by 9 wkts" / "by 37 runs"). */
function synthPlan(rng: Rng, teams: [TeamRef, TeamRef], result: MatchResult, overs: number): [InningsPlan, InningsPlan] {
  const allotted = overs * 6;
  const winner = result.winnerKey ?? teams[0].key;
  const loser = teams.find((t) => t.key !== winner)?.key ?? teams[1].key;
  const margin = result.margin ?? { value: 5, unit: 'WICKETS' as const };
  if (margin.unit === 'WICKETS') {
    const w1 = rng.int(5, 10);
    const r1 = rng.int(Math.round(overs * 4.5), Math.round(overs * 7.5));
    const b1 = w1 === 10 ? rng.int(Math.round(allotted * 0.7), allotted - 1) : allotted;
    const w2 = Math.max(0, 10 - margin.value);
    const b2 = rng.int(Math.round(allotted * (margin.value >= 8 ? 0.4 : 0.6)), allotted - 2);
    return [
      { battingKey: loser, bowlingKey: winner, runs: r1, wickets: w1, balls: b1, target: null },
      { battingKey: winner, bowlingKey: loser, runs: r1 + 1 + rng.int(0, 3), wickets: w2, balls: b2, target: r1 + 1 },
    ];
  }
  const r1 = Math.max(margin.value + Math.round(overs * 3), rng.int(Math.round(overs * 6), Math.round(overs * 8.5)));
  const w1 = rng.int(3, 9);
  const r2 = r1 - margin.value;
  const allOut = rng.chance(0.6);
  return [
    { battingKey: winner, bowlingKey: loser, runs: r1, wickets: w1, balls: allotted, target: null },
    { battingKey: loser, bowlingKey: winner, runs: r2, wickets: allOut ? 10 : rng.int(5, 9), balls: allOut ? rng.int(Math.round(allotted * 0.7), allotted - 1) : allotted, target: r1 + 1 },
  ];
}

let cache: ReplayScript[] | undefined;

/** Every replayable match, built from the real captures in fixtures/. Deterministic. */
export function replayScripts(): ReplayScript[] {
  if (cache) return cache;
  const captured = new Map<string, SquadPlayer[]>();
  for (const raw of seriesSquad) {
    const parsed = rawSquadSchema.safeParse(raw);
    if (parsed.success) {
      const squad = normalizeSquad(parsed.data);
      captured.set(squad.team.key, squad.players);
    }
  }

  const scripts: ReplayScript[] = [];
  // 1) Matches with real final scores.
  for (const raw of currentMatches) {
    const m = normalizeMatch(rawMatchSchema.parse(raw));
    const [i1, i2] = m?.innings ?? [];
    if (!m || !i1 || !i2 || !m.result) continue;
    const rng = Rng.fromString(m.providerId);
    const standard = STANDARD_OVERS[m.format] ?? 20;
    // Rain-reduced first innings that wasn't all out: its overs were the allotment.
    const reduced = i1.wickets < 10 && i1.balls < standard * 6 ? Math.ceil(i1.balls / 6) : null;
    const overs = reduced ?? m.scheduledOvers ?? standard;
    const dls = m.result.method === 'DLS';
    scripts.push({
      id: slug(`${m.matchLabel ?? 'match'}-${m.teams[0].shortName}-${m.teams[1].shortName}-${m.providerId.slice(0, 4)}`),
      sourceProviderId: m.providerId,
      title: m.title,
      matchLabel: m.matchLabel,
      seriesName: m.seriesName,
      format: m.format,
      scheduledOvers: overs,
      venue: m.venue,
      teams: m.teams,
      toss: synthToss(rng, m.teams, i1.battingTeamKey),
      plan: [
        { battingKey: i1.battingTeamKey, bowlingKey: i1.bowlingTeamKey, runs: i1.runs, wickets: i1.wickets, balls: i1.balls, target: null },
        { battingKey: i2.battingTeamKey, bowlingKey: i2.bowlingTeamKey, runs: i2.runs, wickets: i2.wickets, balls: i2.balls, target: dls ? i2.runs : i1.runs + 1 },
      ],
      result: m.result,
      resultText: m.statusText,
      squads: squadMap(m.teams, captured),
      scoreSynthesized: false,
    });
  }

  // 2) Series matches that only have a result line, but real squads.
  for (const raw of seriesInfo.matchList) {
    const m = normalizeMatch(rawMatchSchema.parse(raw), seriesInfo.info.name);
    if (!m?.result || m.result.type !== 'WIN') continue;
    const rng = Rng.fromString(m.providerId);
    const overs = m.scheduledOvers ?? 20;
    const plan = synthPlan(rng, m.teams, m.result, overs);
    scripts.push({
      id: slug(`${m.matchLabel ?? 'match'}-${m.teams[0].shortName}-${m.teams[1].shortName}-${m.providerId.slice(0, 4)}`),
      sourceProviderId: m.providerId,
      title: m.title,
      matchLabel: m.matchLabel,
      seriesName: m.seriesName,
      format: m.format,
      scheduledOvers: overs,
      venue: m.venue,
      teams: m.teams,
      toss: synthToss(rng, m.teams, plan[0].battingKey),
      plan,
      result: m.result,
      resultText: m.statusText,
      squads: squadMap(m.teams, captured),
      scoreSynthesized: true,
    });
  }
  cache = scripts;
  return scripts;
}

export function findScript(id: string): ReplayScript | undefined {
  return replayScripts().find((s) => s.id === id);
}
