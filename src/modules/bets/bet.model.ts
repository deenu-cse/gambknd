import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const BET_STATUSES = ['PENDING_DELAY', 'ACCEPTED', 'REJECTED', 'WON', 'LOST', 'VOID', 'CASHED_OUT'] as const;
export type BetStatus = (typeof BET_STATUSES)[number];
export const OPEN_BET_STATUSES: readonly BetStatus[] = ['PENDING_DELAY', 'ACCEPTED'];
export const SETTLED_BET_STATUSES: readonly BetStatus[] = ['WON', 'LOST', 'VOID', 'CASHED_OUT'];

export const LEG_RESULTS = ['PENDING', 'WON', 'LOST', 'VOID', 'DEAD_HEAT'] as const;
export type LegResultStatus = (typeof LEG_RESULTS)[number];

export interface IBetLeg {
  matchId: Types.ObjectId;
  marketId: Types.ObjectId;
  selectionId: string;
  marketType: string;
  marketName: string;
  selectionName: string;
  matchTitle: string;
  lineX10: number | null;
  /** Odds the bet is struck at (×100). */
  odds: number;
  /** Odds the user asked for (may be lower when better odds were accepted). */
  requestedOdds: number;
  /** Market version at placement; acceptance requires the market not to have moved against the bet. */
  marketVersion: number;
  inPlay: boolean;
  result: LegResultStatus;
  deadHeatWays: number | null;
}

export interface IBet {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  kind: 'SINGLE' | 'ACCA';
  legs: IBetLeg[];
  stake: number;
  /** Combined odds (×100); for singles the leg odds. */
  odds: number;
  potentialReturn: number;
  status: BetStatus;
  idempotencyKey: string;
  placedAt: Date;
  /** When an in-play bet's delay ends and it gets re-checked. */
  acceptAt: Date | null;
  acceptedAt: Date | null;
  settledAt: Date | null;
  payout: number;
  rejectReason: string | null;
  voidReason: string | null;
  cashout: { amount: number; at: Date } | null;
  /** +1 each time a resettlement reverses this bet; namespaces the ledger keys of each settlement. */
  settlementRound: number;
  ip: string | null;
  userAgent: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type BetDoc = HydratedDocument<IBet>;

const legSchema = new Schema<IBetLeg>(
  {
    matchId: { type: Schema.Types.ObjectId, ref: 'Match', required: true },
    marketId: { type: Schema.Types.ObjectId, ref: 'Market', required: true },
    selectionId: { type: String, required: true },
    marketType: { type: String, required: true },
    marketName: { type: String, required: true },
    selectionName: { type: String, required: true },
    matchTitle: { type: String, required: true },
    lineX10: { type: Number, default: null },
    odds: { type: Number, required: true, min: 101 },
    requestedOdds: { type: Number, required: true, min: 101 },
    marketVersion: { type: Number, required: true },
    inPlay: { type: Boolean, required: true },
    result: { type: String, enum: LEG_RESULTS, default: 'PENDING' },
    deadHeatWays: { type: Number, default: null },
  },
  { _id: false },
);

const int = { type: Number, required: true, validate: { validator: Number.isSafeInteger, message: 'must be an integer' } };

const betSchema = new Schema<IBet>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['SINGLE', 'ACCA'], required: true },
    legs: { type: [legSchema], validate: (v: unknown[]) => v.length >= 1 && v.length <= 10 },
    stake: { ...int, min: 1 },
    odds: { ...int, min: 101 },
    potentialReturn: { ...int, min: 1 },
    status: { type: String, enum: BET_STATUSES, required: true },
    idempotencyKey: { type: String, required: true, maxlength: 100 },
    placedAt: { type: Date, required: true },
    acceptAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    settledAt: { type: Date, default: null },
    payout: { ...int, default: 0 },
    rejectReason: { type: String, default: null },
    voidReason: { type: String, default: null },
    cashout: { type: Schema.Types.Mixed, default: null },
    settlementRound: { type: Number, default: 0 },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);
betSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
betSchema.index({ userId: 1, createdAt: -1 });
betSchema.index({ userId: 1, status: 1, createdAt: -1 });
betSchema.index({ 'legs.marketId': 1, status: 1 });
betSchema.index({ 'legs.matchId': 1, status: 1 });
betSchema.index({ status: 1, acceptAt: 1 });
betSchema.index({ createdAt: -1 });
betSchema.index({ placedAt: -1 });
betSchema.index({ settledAt: -1 });

export const Bet = model<IBet>('Bet', betSchema);
