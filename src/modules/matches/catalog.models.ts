import { Schema, model, type Types } from 'mongoose';
import { PLAYER_ROLES, type DataSource, type PlayerProfile, type PlayerRole } from '../../providers/cricket/types.js';

// ── Series ──────────────────────────────────────────────────────────────────
export interface ISeries {
  _id: Types.ObjectId;
  providerRef: { provider: DataSource; id: string };
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  fixtureCounts: { odi: number; t20: number; test: number; total: number };
  squadsAnnounced: number;
  isShadow: boolean;
  lastSyncedAt: Date;
}

const seriesSchema = new Schema<ISeries>(
  {
    providerRef: { provider: { type: String, required: true }, id: { type: String, required: true } },
    name: { type: String, required: true },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    fixtureCounts: { odi: Number, t20: Number, test: Number, total: Number },
    squadsAnnounced: { type: Number, default: 0 },
    isShadow: { type: Boolean, default: false },
    lastSyncedAt: { type: Date, required: true },
  },
  { collection: 'series' },
);
seriesSchema.index({ 'providerRef.provider': 1, 'providerRef.id': 1 }, { unique: true });
seriesSchema.index({ startDate: -1 });
export const Series = model<ISeries>('Series', seriesSchema);

// ── Team (no provider ids exist: identity is the normalized name key, A-05) ──
export interface ITeam {
  _id: Types.ObjectId;
  key: string;
  name: string;
  shortName: string;
  logoUrl: string | null;
  countryCode: string | null;
  flagUrl: string | null;
  aliases: string[];
  updatedAt: Date;
}

const teamSchema = new Schema<ITeam>(
  {
    key: { type: String, required: true },
    name: { type: String, required: true },
    shortName: { type: String, required: true },
    logoUrl: { type: String, default: null },
    countryCode: { type: String, default: null },
    flagUrl: { type: String, default: null },
    aliases: { type: [String], default: [] },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
teamSchema.index({ key: 1 }, { unique: true });
teamSchema.index({ aliases: 1 });
export const Team = model<ITeam>('Team', teamSchema);

// ── Player (identity: provider player id string `pid`) ───────────────────────
export interface IPlayer {
  _id: Types.ObjectId;
  pid: string;
  source: DataSource;
  name: string;
  role: PlayerRole;
  battingStyle: 'RHB' | 'LHB' | null;
  bowlingStyle: string | null;
  bowlingType: 'PACE' | 'SPIN' | null;
  country: string | null;
  imageUrl: string | null;
  teamKeys: string[];
  placeOfBirth: string | null;
  dateOfBirth: Date | null;
  stats: PlayerProfile['stats'] | null;
  statsSyncedAt: Date | null;
}

const playerSchema = new Schema<IPlayer>(
  {
    pid: { type: String, required: true },
    source: { type: String, enum: ['live', 'replay'], required: true },
    name: { type: String, required: true },
    role: { type: String, enum: PLAYER_ROLES, default: 'UNKNOWN' },
    battingStyle: { type: String, default: null },
    bowlingStyle: { type: String, default: null },
    bowlingType: { type: String, default: null },
    country: { type: String, default: null },
    imageUrl: { type: String, default: null },
    teamKeys: { type: [String], default: [] },
    placeOfBirth: { type: String, default: null },
    dateOfBirth: { type: Date, default: null },
    stats: { type: Schema.Types.Mixed, default: null },
    statsSyncedAt: { type: Date, default: null },
  },
  { collection: 'players' },
);
playerSchema.index({ pid: 1 }, { unique: true });
playerSchema.index({ teamKeys: 1 });
playerSchema.index({ name: 'text' });
export const Player = model<IPlayer>('Player', playerSchema);

// ── Country (flags for national teams) ──────────────────────────────────────
export interface ICountry {
  code: string;
  name: string;
  flagUrl: string;
}
const countrySchema = new Schema<ICountry>({ code: { type: String, required: true }, name: { type: String, required: true }, flagUrl: String }, { collection: 'countries' });
countrySchema.index({ code: 1 }, { unique: true });
countrySchema.index({ name: 1 });
export const Country = model<ICountry>('Country', countrySchema);
