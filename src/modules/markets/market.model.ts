import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  MARKET_GROUPS,
  MARKET_STATUSES,
  MARKET_TYPES,
  SELECTION_STATUSES,
  SUSPEND_REASONS,
  type MarketGroup,
  type MarketParams,
  type MarketStatus,
  type MarketType,
  type SelectionStatus,
  type SuspendReason,
} from './types.js';

export interface ISelection {
  id: string;
  name: string;
  teamKey: string | null;
  playerId: string | null;
  /** Offered decimal odds ×100 (185 = 1.85), on the ladder, clamped 1.01–100. */
  odds: number;
  /** Fair (pre-margin) probability, basis points. Never shown to users. */
  probabilityBps: number;
  status: SelectionStatus;
}

export interface MarketResult {
  winningSelectionIds: string[];
  /** Dead heats pay a fraction of the stake at full odds: share = 1 / deadHeatWays. */
  deadHeatWays: number;
  isVoid: boolean;
  reason: string | null;
  /** The settled number for line markets (runs), for display and audit. */
  settledValue: number | null;
  /** Selections void within an otherwise settled market (e.g. a player who didn't take part). */
  voidSelectionIds: string[];
}

export interface IMarket {
  _id: Types.ObjectId;
  matchId: Types.ObjectId;
  key: string;
  type: MarketType;
  group: MarketGroup;
  name: string;
  params: MarketParams;
  selections: ISelection[];
  status: MarketStatus;
  suspendReason: SuspendReason | null;
  /** Identifies the delivery that triggered a ball suspension; the reopen job only lifts its own. */
  suspendToken: string | null;
  /** Last time the market went OPEN → SUSPENDED. Delayed bets placed before this are rejected. */
  lastSuspendedAt: Date | null;
  inPlay: boolean;
  /** false = admin-managed: the engine suspends/closes it but never reprices it. */
  autoManaged: boolean;
  marginBps: number;
  betDelayMs: number;
  minStake: number;
  maxStake: number;
  maxLiability: number;
  lineX10: number | null;
  sortOrder: number;
  result: MarketResult | null;
  settledAt: Date | null;
  closedAt: Date | null;
  lastPricedAt: Date | null;
  /** +1 on every change (status or odds). Bets carry it to detect stale prices. */
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MarketDoc = HydratedDocument<IMarket>;

const selectionSchema = new Schema<ISelection>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    teamKey: { type: String, default: null },
    playerId: { type: String, default: null },
    odds: { type: Number, required: true, min: 101, max: 10_000, validate: Number.isInteger },
    probabilityBps: { type: Number, required: true, min: 0, max: 10_000 },
    status: { type: String, enum: SELECTION_STATUSES, default: 'ACTIVE' },
  },
  { _id: false },
);

const marketSchema = new Schema<IMarket>(
  {
    matchId: { type: Schema.Types.ObjectId, ref: 'Match', required: true },
    key: { type: String, required: true },
    type: { type: String, enum: MARKET_TYPES, required: true },
    group: { type: String, enum: MARKET_GROUPS, required: true },
    name: { type: String, required: true, maxlength: 120 },
    params: { type: Schema.Types.Mixed, default: () => ({}) },
    selections: { type: [selectionSchema], validate: (v: unknown[]) => v.length >= 2 && v.length <= 40 },
    status: { type: String, enum: MARKET_STATUSES, default: 'PENDING' },
    suspendReason: { type: String, enum: [...SUSPEND_REASONS, null], default: null },
    suspendToken: { type: String, default: null },
    lastSuspendedAt: { type: Date, default: null },
    inPlay: { type: Boolean, required: true },
    autoManaged: { type: Boolean, default: true },
    marginBps: { type: Number, required: true, min: 0, max: 5_000 },
    betDelayMs: { type: Number, required: true, min: 0, max: 15_000 },
    minStake: { type: Number, required: true, min: 1 },
    maxStake: { type: Number, required: true, min: 1 },
    maxLiability: { type: Number, required: true, min: 1 },
    lineX10: { type: Number, default: null },
    sortOrder: { type: Number, default: 100 },
    result: { type: Schema.Types.Mixed, default: null },
    settledAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    lastPricedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
    createdBy: { type: String, default: 'system' },
  },
  { timestamps: true },
);
marketSchema.index({ matchId: 1, key: 1 }, { unique: true });
marketSchema.index({ matchId: 1, status: 1, sortOrder: 1 });
marketSchema.index({ status: 1, updatedAt: -1 });

export const Market = model<IMarket>('Market', marketSchema);
