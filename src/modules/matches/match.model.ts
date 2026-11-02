import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  MATCH_FORMATS,
  MATCH_STATUSES,
  type BallEvent as ProviderBall,
  type DataSource,
  type Innings,
  type MatchFormat,
  type MatchResult,
  type MatchStatus,
  type ProviderCapabilities,
  type SquadPlayer,
  type TeamRef,
  type Toss,
  type Venue,
} from '../../providers/cricket/types.js';

export interface CreaseBatter {
  id: string;
  name: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
}

export interface CreaseBowler {
  id: string;
  name: string;
  balls: number;
  runs: number;
  wickets: number;
  maidens: number;
}

/** Everything the live scoreboard needs, precomputed on every sync. Rates are ×100 integers. */
export interface CurrentState {
  inningsNumber: number;
  battingTeamKey: string;
  bowlingTeamKey: string;
  runs: number;
  wickets: number;
  balls: number;
  runRate100: number;
  target: number | null;
  runsNeeded: number | null;
  ballsRemaining: number | null;
  requiredRunRate100: number | null;
  striker: CreaseBatter | null;
  nonStriker: CreaseBatter | null;
  bowler: CreaseBowler | null;
  partnership: { runs: number; balls: number };
  lastSixBalls: string[];
  currentOverRuns: number;
  /** Fair win probability for teams[0], basis points (0–10000). Set by the odds engine. */
  winProbabilityBps: number | null;
}

export interface IMatch {
  _id: Types.ObjectId;
  providerRef: { provider: DataSource; id: string };
  source: DataSource;
  seriesId: Types.ObjectId | null;
  seriesName: string | null;
  title: string;
  matchLabel: string | null;
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
  currentState: CurrentState | null;
  squads: Array<{ teamKey: string; players: SquadPlayer[] }>;
  squadsSyncedAt: Date | null;
  bettingEnabled: boolean;
  featured: boolean;
  stale: boolean;
  lastSyncedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MatchDoc = HydratedDocument<IMatch>;

const matchSchema = new Schema<IMatch>(
  {
    providerRef: { provider: { type: String, required: true }, id: { type: String, required: true } },
    source: { type: String, enum: ['live', 'replay'], required: true },
    seriesId: { type: Schema.Types.ObjectId, ref: 'Series', default: null },
    seriesName: { type: String, default: null },
    title: { type: String, required: true },
    matchLabel: { type: String, default: null },
    format: { type: String, enum: MATCH_FORMATS, required: true },
    scheduledOvers: { type: Number, default: null },
    teams: { type: Schema.Types.Mixed, required: true },
    venue: { type: Schema.Types.Mixed, default: null },
    startTime: { type: Date, required: true },
    startTimeConfirmed: { type: Boolean, default: true },
    status: { type: String, enum: MATCH_STATUSES, required: true },
    statusText: { type: String, default: '' },
    toss: { type: Schema.Types.Mixed, default: null },
    innings: { type: Schema.Types.Mixed, default: () => [] },
    result: { type: Schema.Types.Mixed, default: null },
    capabilities: { type: Schema.Types.Mixed, required: true },
    currentState: { type: Schema.Types.Mixed, default: null },
    squads: { type: Schema.Types.Mixed, default: () => [] },
    squadsSyncedAt: { type: Date, default: null },
    bettingEnabled: { type: Boolean, default: true },
    featured: { type: Boolean, default: false },
    stale: { type: Boolean, default: false },
    lastSyncedAt: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
matchSchema.index({ 'providerRef.provider': 1, 'providerRef.id': 1 }, { unique: true });
matchSchema.index({ status: 1, startTime: 1 });
matchSchema.index({ seriesId: 1, startTime: 1 });
matchSchema.index({ 'teams.key': 1, startTime: -1 });
matchSchema.index({ endedAt: -1 });
export const Match = model<IMatch>('Match', matchSchema);

// ── Ball events (commentary + fancy-market settlement) ──────────────────────
export interface IBallEvent extends Omit<ProviderBall, 'occurredAt'> {
  _id: Types.ObjectId;
  matchId: Types.ObjectId;
  occurredAt: Date;
}

const ballSchema = new Schema<IBallEvent>(
  {
    matchId: { type: Schema.Types.ObjectId, ref: 'Match', required: true },
    innings: { type: Number, required: true },
    over: { type: Number, required: true },
    ballInOver: { type: Number, required: true },
    seq: { type: Number, required: true },
    batterId: String,
    batterName: String,
    nonStrikerId: String,
    bowlerId: String,
    bowlerName: String,
    runsBat: Number,
    extras: { wides: Number, noBalls: Number, byes: Number, legByes: Number, penalty: Number },
    totalRuns: Number,
    isLegal: Boolean,
    isBoundary: Boolean,
    wicket: { type: Schema.Types.Mixed, default: null },
    commentary: String,
    scoreAfter: { runs: Number, wickets: Number, balls: Number },
    occurredAt: { type: Date, required: true },
  },
  { collection: 'ball_events' },
);
ballSchema.index({ matchId: 1, innings: 1, seq: 1 }, { unique: true });
ballSchema.index({ matchId: 1, occurredAt: -1 });
export const BallEventModel = model<IBallEvent>('BallEvent', ballSchema);
