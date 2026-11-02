import { Schema, model } from 'mongoose';

export const PROVIDER_MODES = ['live', 'replay'] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

/** Platform-wide knobs. Exactly one document (_id: 'global'). All amounts in minor units, margins in basis points. */
export interface ISettings {
  _id: 'global';
  welcomeBonus: number;
  dailyBonus: number;
  /** Default overround per market type, in basis points (500 = 5%). */
  defaultMarginsBps: Record<string, number>;
  defaultBetDelayMs: number;
  marketReopenDelayMs: number;
  globalMinStake: number;
  globalMaxStake: number;
  defaultMaxLiability: number;
  cashoutMarginBps: number;
  adminMaxAdjustment: number;
  staleThresholdMs: number;
  /** Market types the engine creates automatically. */
  marketTypesEnabled: string[];
  /** Suspend a market while any selection's fair probability is above this (no fair price). */
  oneSidedThresholdBps: number;
  /** Liability shading: start at this share of maxLiability, boost a selection by at most this much. */
  shadingStartBps: number;
  shadingMaxBoostBps: number;
  maintenance: { enabled: boolean; message: string };
  providerMode: ProviderMode;
  version: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export const DEFAULT_SETTINGS: Omit<ISettings, '_id' | 'updatedAt' | 'updatedBy' | 'version'> = {
  welcomeBonus: 1_000_00, // 1,000 tokens
  dailyBonus: 100_00, // 100 tokens
  defaultMarginsBps: {
    MATCH_WINNER: 500,
    TOSS_WINNER: 500,
    INNINGS_TOTAL: 600,
    SESSION_RUNS: 800,
    NEXT_OVER_RUNS: 800,
    FALL_OF_NEXT_WICKET: 800,
    TOP_BATSMAN: 1500,
    TOP_BOWLER: 1500,
    DISMISSAL_METHOD: 1000,
    PLAYER_RUNS: 800,
    OPENING_PARTNERSHIP: 800,
  },
  defaultBetDelayMs: 4_000,
  marketReopenDelayMs: 3_000,
  globalMinStake: 10_00, // 10 tokens
  globalMaxStake: 50_000_00, // 50,000 tokens
  defaultMaxLiability: 500_000_00, // 500,000 tokens worst-case per market
  cashoutMarginBps: 500,
  adminMaxAdjustment: 100_000_00, // 100,000 tokens per admin action
  staleThresholdMs: 30_000,
  marketTypesEnabled: [
    'MATCH_WINNER', 'TOSS_WINNER', 'INNINGS_TOTAL', 'SESSION_RUNS', 'NEXT_OVER_RUNS', 'FALL_OF_NEXT_WICKET',
    'TOP_BATSMAN', 'TOP_BOWLER', 'DISMISSAL_METHOD', 'PLAYER_RUNS', 'OPENING_PARTNERSHIP',
  ],
  oneSidedThresholdBps: 9_700,
  shadingStartBps: 5_000,
  shadingMaxBoostBps: 1_500,
  maintenance: { enabled: false, message: '' },
  providerMode: 'replay',
};

const settingsSchema = new Schema<ISettings>(
  {
    _id: { type: String, default: 'global' },
    welcomeBonus: { type: Number, required: true, min: 0 },
    dailyBonus: { type: Number, required: true, min: 0 },
    defaultMarginsBps: { type: Map, of: Number, required: true },
    defaultBetDelayMs: { type: Number, required: true, min: 0, max: 15_000 },
    marketReopenDelayMs: { type: Number, required: true, min: 0, max: 30_000 },
    globalMinStake: { type: Number, required: true, min: 1 },
    globalMaxStake: { type: Number, required: true, min: 1 },
    defaultMaxLiability: { type: Number, required: true, min: 1 },
    cashoutMarginBps: { type: Number, required: true, min: 0, max: 5_000 },
    adminMaxAdjustment: { type: Number, required: true, min: 1 },
    staleThresholdMs: { type: Number, required: true, min: 5_000 },
    marketTypesEnabled: { type: [String], default: undefined },
    oneSidedThresholdBps: { type: Number, min: 5_000, max: 9_999 },
    shadingStartBps: { type: Number, min: 0, max: 10_000 },
    shadingMaxBoostBps: { type: Number, min: 0, max: 5_000 },
    maintenance: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: '', maxlength: 500 },
    },
    providerMode: { type: String, enum: PROVIDER_MODES, required: true },
    version: { type: Number, default: 0 },
    updatedBy: { type: String, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'settings' },
);

export const Settings = model<ISettings>('Settings', settingsSchema);
