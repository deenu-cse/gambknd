import { getRedis } from '../../../config/redis.js';
import { FINISHED_STATUSES, type Innings, type MatchFormat, type SquadPlayer } from '../../../providers/cricket/types.js';
import { Player } from '../../matches/catalog.models.js';
import { BallEventModel, Match, type IMatch } from '../../matches/match.model.js';
import { sidePar, type InningsState } from '../odds/probability.js';

/** Runs per over at par when we have no history (A-22). */
const DEFAULT_PAR_PER_OVER: Record<MatchFormat, number> = { T10: 10, T20: 7.8, ODI: 5.6, TEST: 3.2 };
const TEST_INNINGS_BALLS = 540; // 90 overs: a nominal day's play, used only for Test projections

export interface PlayerForm {
  playerId: string;
  name: string;
  role: string;
  battingAverage100: number | null;
  strikeRate100: number | null;
  wickets: number | null;
  bowlingMatches: number | null;
  bowlingType: 'PACE' | 'SPIN' | null;
}

export interface PreMatchFacts {
  /** Expected first-innings total for this match's overs. */
  par: number;
  parSource: 'series' | 'venue' | 'format' | 'default';
  strength: Record<string, number>;
  /** Head-to-head edge for teams[0], −1..1. */
  h2h: number;
}

export interface LastBall {
  innings: number;
  over: number;
  ballInOver: number;
  isLegal: boolean;
  bowlerId: string;
}

export interface PricingContext {
  match: IMatch;
  limitedOvers: boolean;
  allottedBalls: number;
  facts: PreMatchFacts;
  squads: Record<string, PlayerForm[]>;
  lastBall: LastBall | null;
  finished: boolean;
  /** Batting order once known (innings 1 or the toss). */
  battingFirst: string | null;
  inningsOf(n: number): Innings | null;
  /** The innings currently being played (or about to start), if any. */
  current(): Innings | null;
  parFor(teamKey: string): number;
  stateOf(inn: Innings): InningsState;
}

async function averageFirstInnings(filter: Record<string, unknown>, minMatches: number): Promise<number | null> {
  const rows = await Match.find({ ...filter, status: 'COMPLETED', 'innings.0': { $exists: true } }).select('innings scheduledOvers').sort({ endedAt: -1 }).limit(30).lean();
  const rates = rows
    .map((m) => {
      const first = m.innings[0];
      const overs = m.scheduledOvers ?? 0;
      return first && overs > 0 ? first.runs / overs : null;
    })
    .filter((r): r is number => r !== null && r > 0);
  if (rates.length < minMatches) return null;
  return rates.reduce((s, r) => s + r, 0) / rates.length;
}

async function strengthOf(teamKey: string, excludeId: IMatch['_id']): Promise<number> {
  const rows = await Match.find({ _id: { $ne: excludeId }, 'teams.key': teamKey, status: 'COMPLETED', 'result.type': 'WIN' }).select('result').sort({ endedAt: -1 }).limit(10).lean();
  const wins = rows.filter((m) => m.result?.winnerKey === teamKey).length;
  return (wins + 1) / (rows.length + 2);
}

async function headToHead(a: string, b: string, excludeId: IMatch['_id']): Promise<number> {
  const rows = await Match.find({ _id: { $ne: excludeId }, 'teams.key': { $all: [a, b] }, status: 'COMPLETED', 'result.type': 'WIN' }).select('result').limit(10).lean();
  const aw = rows.filter((m) => m.result?.winnerKey === a).length;
  const bw = rows.filter((m) => m.result?.winnerKey === b).length;
  return (aw - bw) / (rows.length + 2);
}

/** Data-driven par and strengths, cached 10 minutes per match (they change slowly). */
export async function preMatchFacts(match: IMatch): Promise<PreMatchFacts> {
  const key = `pricing:prematch:${match._id.toString()}`;
  const cached = await getRedis().get(key);
  if (cached) return JSON.parse(cached) as PreMatchFacts;

  const overs = match.scheduledOvers ?? (match.format === 'TEST' ? 90 : 20);
  const base = { _id: { $ne: match._id }, format: match.format };
  let parSource: PreMatchFacts['parSource'] = 'default';
  let rate: number | null = null;
  if (match.seriesId) {
    rate = await averageFirstInnings({ ...base, seriesId: match.seriesId }, 2);
    if (rate) parSource = 'series';
  }
  if (!rate && match.venue?.name) {
    rate = await averageFirstInnings({ ...base, 'venue.name': match.venue.name }, 2);
    if (rate) parSource = 'venue';
  }
  if (!rate) {
    rate = await averageFirstInnings(base, 5);
    if (rate) parSource = 'format';
  }
  const [a, b] = match.teams;
  const facts: PreMatchFacts = {
    par: Math.round((rate ?? DEFAULT_PAR_PER_OVER[match.format]) * overs),
    parSource,
    strength: { [a.key]: await strengthOf(a.key, match._id), [b.key]: await strengthOf(b.key, match._id) },
    h2h: await headToHead(a.key, b.key, match._id),
  };
  await getRedis().set(key, JSON.stringify(facts), 'EX', 600);
  return facts;
}

async function squadForms(match: IMatch): Promise<Record<string, PlayerForm[]>> {
  if (match.squads.length === 0) return {};
  const pids = match.squads.flatMap((s) => s.players.map((p) => p.playerId));
  const docs = await Player.find({ pid: { $in: pids } }).select('pid stats').lean();
  const stats = new Map(docs.map((d) => [d.pid, d.stats]));
  const fmt = match.format === 'T10' ? 'T20' : match.format;
  const form = (p: SquadPlayer): PlayerForm => {
    const s = stats.get(p.playerId);
    const bat = s?.batting[fmt];
    const bowl = s?.bowling[fmt];
    return {
      playerId: p.playerId,
      name: p.name,
      role: p.role,
      battingAverage100: bat?.average100 ?? null,
      strikeRate100: bat?.strikeRate100 ?? null,
      wickets: bowl?.wickets ?? null,
      bowlingMatches: bowl?.matches ?? null,
      bowlingType: p.bowlingType,
    };
  };
  return Object.fromEntries(match.squads.map((s) => [s.teamKey, s.players.map(form)]));
}

export async function buildContext(match: IMatch): Promise<PricingContext> {
  const [facts, squads, last] = await Promise.all([
    preMatchFacts(match),
    squadForms(match),
    BallEventModel.findOne({ matchId: match._id }).sort({ innings: -1, seq: -1 }).select('innings over ballInOver isLegal bowlerId').lean(),
  ]);
  const limitedOvers = match.format !== 'TEST' && match.scheduledOvers !== null;
  const allottedBalls = limitedOvers ? (match.scheduledOvers ?? 20) * 6 : TEST_INNINGS_BALLS;
  const tossBatFirst = match.toss ? (match.toss.decision === 'BAT' ? match.toss.winnerKey : match.teams.find((t) => t.key !== match.toss?.winnerKey)?.key ?? null) : null;
  const battingFirst = match.innings[0]?.battingTeamKey ?? tossBatFirst;

  const ctx: PricingContext = {
    match,
    limitedOvers,
    allottedBalls,
    facts,
    squads,
    lastBall: last ? { innings: last.innings, over: last.over, ballInOver: last.ballInOver, isLegal: last.isLegal, bowlerId: last.bowlerId } : null,
    finished: FINISHED_STATUSES.includes(match.status),
    battingFirst,
    inningsOf: (n) => match.innings.find((i) => i.number === n) ?? null,
    current: () => {
      const last = match.innings.at(-1);
      return last && !last.isComplete ? last : null;
    },
    parFor: (teamKey) => sidePar(facts.par, facts.strength[teamKey] ?? 0.5),
    stateOf: (inn) => ({
      runs: inn.runs,
      wicketsLost: inn.wickets,
      ballsBowled: inn.balls,
      allottedBalls: inn.allottedBalls ?? allottedBalls,
      par: sidePar(facts.par, facts.strength[inn.battingTeamKey] ?? 0.5),
    }),
  };
  return ctx;
}
