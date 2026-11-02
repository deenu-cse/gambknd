import { ballsToOvers } from '../../providers/cricket/normalizers/text.js';
import type { DataSource, Innings, MatchFormat, MatchResult, MatchStatus, TeamRef, Toss, Venue } from '../../providers/cricket/types.js';
import type { CurrentState, IBallEvent, IMatch } from './match.model.js';

export interface InningsBrief {
  number: number;
  teamKey: string;
  runs: number;
  wickets: number;
  balls: number;
  overs: string;
  isComplete: boolean;
  target: number | null;
}

/** List card. Everything a match tile needs, nothing more. */
export interface MatchSummaryView {
  id: string;
  source: DataSource;
  title: string;
  matchLabel: string | null;
  series: { id: string | null; name: string | null };
  format: MatchFormat;
  teams: TeamRef[];
  venue: Venue | null;
  startTime: Date;
  startTimeConfirmed: boolean;
  status: MatchStatus;
  statusText: string;
  score: InningsBrief[];
  result: MatchResult | null;
  bettingEnabled: boolean;
  featured: boolean;
  stale: boolean;
  lastSyncedAt: Date;
}

/** Live scoreboard: summary + toss + crease state. Pushed on every change over Socket.IO. */
export interface MatchLiveView extends MatchSummaryView {
  scheduledOvers: number | null;
  toss: Toss | null;
  currentState: CurrentState | null;
  capabilities: IMatch['capabilities'];
}

export interface BallView {
  id: string;
  innings: number;
  over: number;
  ballInOver: number;
  seq: number;
  label: string; // "13.4"
  batter: { id: string; name: string };
  bowler: { id: string; name: string };
  runsBat: number;
  totalRuns: number;
  extras: IBallEvent['extras'];
  isLegal: boolean;
  isBoundary: boolean;
  wicket: IBallEvent['wicket'];
  commentary: string;
  scoreAfter: IBallEvent['scoreAfter'];
  occurredAt: Date;
}

export function inningsBrief(inn: Innings): InningsBrief {
  return {
    number: inn.number,
    teamKey: inn.battingTeamKey,
    runs: inn.runs,
    wickets: inn.wickets,
    balls: inn.balls,
    overs: ballsToOvers(inn.balls),
    isComplete: inn.isComplete,
    target: inn.target,
  };
}

type MatchLike = Pick<
  IMatch,
  '_id' | 'source' | 'title' | 'matchLabel' | 'seriesId' | 'seriesName' | 'format' | 'teams' | 'venue' | 'startTime' | 'startTimeConfirmed' | 'status' | 'statusText' | 'innings' | 'result' | 'bettingEnabled' | 'featured' | 'stale' | 'lastSyncedAt' | 'scheduledOvers' | 'toss' | 'currentState' | 'capabilities'
>;

export function toSummary(m: MatchLike): MatchSummaryView {
  return {
    id: m._id.toString(),
    source: m.source,
    title: m.title,
    matchLabel: m.matchLabel,
    series: { id: m.seriesId?.toString() ?? null, name: m.seriesName },
    format: m.format,
    teams: m.teams,
    venue: m.venue,
    startTime: m.startTime,
    startTimeConfirmed: m.startTimeConfirmed,
    status: m.status,
    statusText: m.statusText,
    score: m.innings.map(inningsBrief),
    result: m.result,
    bettingEnabled: m.bettingEnabled,
    featured: m.featured,
    stale: m.stale,
    lastSyncedAt: m.lastSyncedAt,
  };
}

export function toLiveView(m: MatchLike): MatchLiveView {
  return { ...toSummary(m), scheduledOvers: m.scheduledOvers, toss: m.toss, currentState: m.currentState, capabilities: m.capabilities };
}

export function toBallView(b: Pick<IBallEvent, '_id' | 'innings' | 'over' | 'ballInOver' | 'seq' | 'batterId' | 'batterName' | 'bowlerId' | 'bowlerName' | 'runsBat' | 'totalRuns' | 'extras' | 'isLegal' | 'isBoundary' | 'wicket' | 'commentary' | 'scoreAfter' | 'occurredAt'>): BallView {
  return {
    id: b._id.toString(),
    innings: b.innings,
    over: b.over,
    ballInOver: b.ballInOver,
    seq: b.seq,
    label: `${b.over}.${b.ballInOver}`,
    batter: { id: b.batterId, name: b.batterName },
    bowler: { id: b.bowlerId, name: b.bowlerName },
    runsBat: b.runsBat,
    totalRuns: b.totalRuns,
    extras: b.extras,
    isLegal: b.isLegal,
    isBoundary: b.isBoundary,
    wicket: b.wicket,
    commentary: b.commentary,
    scoreAfter: b.scoreAfter,
    occurredAt: b.occurredAt,
  };
}
