import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const USER_ROLES = ['user', 'admin', 'superadmin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended', 'self_excluded'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ODDS_FORMATS = ['decimal', 'fractional', 'american'] as const;
export type OddsFormat = (typeof ODDS_FORMATS)[number];

export const THEMES = ['dark', 'light', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export interface PendingLimitIncrease {
  dailyStakeLimit?: number | null;
  dailyLossLimit?: number | null;
  effectiveAt: Date;
}

export interface ResponsiblePlay {
  /** Max total stake per rolling calendar day (UTC), in token minor units. null = no limit. */
  dailyStakeLimit: number | null;
  /** Max net loss per day (UTC), in minor units. null = no limit. */
  dailyLossLimit: number | null;
  sessionReminderMinutes: number | null;
  cooldownUntil: Date | null;
  selfExcludedUntil: Date | null;
  /** Loosening a limit only takes effect after a 24h cooling-off period; tightening is immediate. */
  pendingIncrease: PendingLimitIncrease | null;
}

export interface UserPreferences {
  oddsFormat: OddsFormat;
  acceptBetterOdds: boolean;
  theme: Theme;
}

export interface UserTotp {
  enabled: boolean;
  secretEnc: string | null;
  pendingSecretEnc: string | null;
}

export interface IUser {
  _id: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string | null;
  googleId: string | null;
  avatar: string | null;
  role: UserRole;
  status: UserStatus;
  statusReason: string | null;
  /** What to restore on unsuspend. A permanent self-exclusion lives only in `status`, so it must survive. */
  statusBeforeSuspend: UserStatus | null;
  emailVerified: boolean;
  preferences: UserPreferences;
  responsiblePlay: ResponsiblePlay;
  totp: UserTotp;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDoc = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    passwordHash: { type: String, default: null, select: false },
    googleId: { type: String, default: null },
    avatar: { type: String, default: null, maxlength: 500 },
    role: { type: String, enum: USER_ROLES, default: 'user', index: true },
    status: { type: String, enum: USER_STATUSES, default: 'active', index: true },
    statusReason: { type: String, default: null, maxlength: 500 },
    statusBeforeSuspend: { type: String, enum: [...USER_STATUSES, null], default: null },
    emailVerified: { type: Boolean, default: false },
    preferences: {
      oddsFormat: { type: String, enum: ODDS_FORMATS, default: 'decimal' },
      acceptBetterOdds: { type: Boolean, default: true },
      theme: { type: String, enum: THEMES, default: 'dark' },
    },
    responsiblePlay: {
      dailyStakeLimit: { type: Number, default: null, min: 0 },
      dailyLossLimit: { type: Number, default: null, min: 0 },
      sessionReminderMinutes: { type: Number, default: null, min: 5, max: 720 },
      cooldownUntil: { type: Date, default: null },
      selfExcludedUntil: { type: Date, default: null },
      pendingIncrease: {
        type: new Schema<PendingLimitIncrease>(
          {
            dailyStakeLimit: { type: Number, default: undefined },
            dailyLossLimit: { type: Number, default: undefined },
            effectiveAt: { type: Date, required: true },
          },
          { _id: false },
        ),
        default: null,
      },
    },
    totp: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, default: null, select: false },
      pendingSecretEnc: { type: String, default: null, select: false },
    },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ googleId: 1 }, { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } });
userSchema.index({ createdAt: -1 });
userSchema.index({ name: 'text', email: 'text' });

export const User = model<IUser>('User', userSchema);

export function isStaff(role: UserRole): boolean {
  return role === 'admin' || role === 'superadmin';
}
