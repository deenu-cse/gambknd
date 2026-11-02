/**
 * Internal, provider-agnostic cricket models. Every CricketProvider returns these.
 * Raw provider payloads never leave src/providers/cricket.
 */

export const MATCH_FORMATS = ['T10', 'T20', 'ODI', 'TEST'] as const;
export type MatchFormat = (typeof MATCH_FORMATS)[number];

export const MATCH_STATUSES = ['UPCOMING', 'TOSS', 'LIVE', 'INNINGS_BREAK', 'RAIN_DELAY', 'COMPLETED', 'ABANDONED', 'NO_RESULT'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const IN_PROGRESS_STATUSES: readonly MatchStatus[] = ['TOSS', 'LIVE', 'INNINGS_BREAK', 'RAIN_DELAY'];
export const FINISHED_STATUSES: readonly MatchStatus[] = ['COMPLETED', 'ABANDONED', 'NO_RESULT'];

export type DataSource = 'live' | 'replay';

export interface TeamRef {
  key: string; // normalized name, our team identity
  name: string;
  shortName: string;
  logoUrl: string | null;
}

export interface Venue {
  name: string;
  city: string | null;
}

export interface Toss {
  winnerKey: string;
  decision: 'BAT' | 'BOWL';
}

export interface MatchResult {
  type: 'WIN' | 'TIE' | 'DRAW' | 'NO_RESULT' | 'ABANDONED';
  winnerKey: string | null;
  margin: { value: number; unit: 'RUNS' | 'WICKETS' } | null;
  method: 'DLS' | null;
  superOver: boolean;
  /** true when the result was parsed confidently enough to settle automatically. */
  confident: boolean;
}

export interface BatterLine {
  playerId: string;
  name: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  dismissal: string | null; // display text, null = not out
  isOut: boolean;
}

export interface BowlerLine {
  playerId: string;
  name: string;
  balls: number;
  maidens: number;
  runs: number;
  wickets: number;
  wides: number;
  noBalls: number;
}

export interface FallOfWicket {
  wicket: number;
  runs: number;
  balls: number;
  playerId: string | null;
  playerName: string | null;
}

export interface Extras {
  wides: number;
  noBalls: number;
  byes: number;
  legByes: number;
  penalty: number;
  total: number;
}

export interface Innings {
  number: number; // 1..4 in match order
  battingTeamKey: string;
  bowlingTeamKey: string;
  battingTeamInferred: boolean;
  runs: number;
  wickets: number;
  balls: number; // legal balls bowled
  isComplete: boolean;
  target: number | null;
  allottedBalls: number | null;
  extras: Extras | null;
  batting: BatterLine[];
  bowling: BowlerLine[];
  fallOfWickets: FallOfWicket[];
}

export const DISMISSAL_KINDS = ['CAUGHT', 'BOWLED', 'LBW', 'RUN_OUT', 'STUMPED', 'HIT_WICKET', 'OTHER'] as const;
export type DismissalKind = (typeof DISMISSAL_KINDS)[number];

export interface BallEvent {
  innings: number;
  over: number; // 0-based over index
  ballInOver: number; // legal-ball count within the over after this delivery (1..6; extras repeat the number)
  seq: number; // monotonically increasing within the innings, includes extras
  batterId: string;
  batterName: string;
  nonStrikerId: string;
  bowlerId: string;
  bowlerName: string;
  runsBat: number;
  extras: { wides: number; noBalls: number; byes: number; legByes: number; penalty: number };
  totalRuns: number;
  isLegal: boolean;
  isBoundary: boolean;
  wicket: { kind: DismissalKind; playerOutId: string; playerOutName: string; fielderName: string | null } | null;
  commentary: string;
  scoreAfter: { runs: number; wickets: number; balls: number };
  occurredAt: Date;
}

export interface ProviderCapabilities {
  ballByBall: boolean;
  scorecard: boolean;
  toss: boolean;
  squads: boolean;
  playerStats: boolean;
}

export interface ProviderMatch {
  providerId: string;
  source: DataSource;
  title: string;
  matchLabel: string | null;
  seriesProviderId: string | null;
  seriesName: string | null;
  format: MatchFormat;
  scheduledOvers: number | null;
  teams: [TeamRef, TeamRef];
  venue: Venue | null;
  startTime: Date;
  startTimeConfirmed: boolean;
  status: MatchStatus;
  statusText: string;
  toss: Toss | null;
  innings: Innings[];
  result: MatchResult | null;
  capabilities: ProviderCapabilities;
}

/** Cheap "has anything changed" probe (cricScore on CricAPI). */
export interface ScoreTick {
  providerId: string;
  phase: 'fixture' | 'live' | 'result';
  fingerprint: string;
}

export interface SquadPlayer {
  playerId: string;
  name: string;
  role: PlayerRole;
  battingStyle: 'RHB' | 'LHB' | null;
  bowlingStyle: string | null;
  bowlingType: 'PACE' | 'SPIN' | null;
  country: string | null;
  imageUrl: string | null;
}

export interface Squad {
  team: TeamRef;
  players: SquadPlayer[];
}

export const PLAYER_ROLES = ['BATTER', 'WK_BATTER', 'BOWLER', 'BAT_ALLROUNDER', 'BOWL_ALLROUNDER', 'UNKNOWN'] as const;
export type PlayerRole = (typeof PLAYER_ROLES)[number];

export type StatFormat = 'TEST' | 'ODI' | 'T20';

export interface BattingStats {
  matches: number; innings: number; runs: number; ballsFaced: number; highScore: number; highScoreNotOut: boolean;
  /** ×100 integers, e.g. 2745 = 27.45 */
  average100: number; strikeRate100: number;
  notOuts: number; fours: number; sixes: number; fifties: number; hundreds: number; doubleHundreds: number;
}

export interface BowlingStats {
  matches: number; innings: number; balls: number; runs: number; wickets: number;
  average100: number; economy100: number; strikeRate100: number;
  bestInnings: { wickets: number; runs: number } | null;
  bestMatch: { wickets: number; runs: number } | null;
  fiveWickets: number; tenWickets: number;
}

export interface PlayerProfile extends SquadPlayer {
  placeOfBirth: string | null;
  dateOfBirth: Date | null;
  stats: {
    batting: Partial<Record<StatFormat, BattingStats>>;
    bowling: Partial<Record<StatFormat, BowlingStats>>;
  };
}

export interface SeriesInfo {
  providerId: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  fixtureCounts: { odi: number; t20: number; test: number; total: number };
  squadsAnnounced: number;
  isShadow: boolean;
}

export interface Country {
  code: string;
  name: string;
  flagUrl: string;
}
