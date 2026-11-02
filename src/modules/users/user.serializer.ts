import type { IUser, OddsFormat, ResponsiblePlay, Theme, UserRole, UserStatus } from './user.model.js';

/** The only user shape that leaves the API. No hashes, secrets or provider ids. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  hasPassword: boolean;
  googleLinked: boolean;
  totpEnabled: boolean;
  preferences: { oddsFormat: OddsFormat; acceptBetterOdds: boolean; theme: Theme };
  responsiblePlay: ResponsiblePlay;
  lastLoginAt: Date | null;
  createdAt: Date;
}

type SerializableUser = Pick<
  IUser,
  '_id' | 'name' | 'email' | 'avatar' | 'role' | 'status' | 'emailVerified' | 'googleId' | 'preferences' | 'responsiblePlay' | 'totp' | 'lastLoginAt' | 'createdAt'
> & { passwordHash?: string | null; hasPassword?: boolean };

export function toPublicUser(u: SerializableUser, opts: { hasPassword?: boolean } = {}): PublicUser {
  const rp = u.responsiblePlay;
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    avatar: u.avatar,
    role: u.role,
    status: u.status,
    emailVerified: u.emailVerified,
    hasPassword: opts.hasPassword ?? Boolean(u.passwordHash),
    googleLinked: Boolean(u.googleId),
    totpEnabled: u.totp?.enabled ?? false,
    preferences: {
      oddsFormat: u.preferences.oddsFormat,
      acceptBetterOdds: u.preferences.acceptBetterOdds,
      theme: u.preferences.theme,
    },
    responsiblePlay: {
      dailyStakeLimit: rp.dailyStakeLimit,
      dailyLossLimit: rp.dailyLossLimit,
      sessionReminderMinutes: rp.sessionReminderMinutes,
      cooldownUntil: rp.cooldownUntil,
      selfExcludedUntil: rp.selfExcludedUntil,
      pendingIncrease: rp.pendingIncrease
        ? {
            ...(rp.pendingIncrease.dailyStakeLimit !== undefined ? { dailyStakeLimit: rp.pendingIncrease.dailyStakeLimit } : {}),
            ...(rp.pendingIncrease.dailyLossLimit !== undefined ? { dailyLossLimit: rp.pendingIncrease.dailyLossLimit } : {}),
            effectiveAt: rp.pendingIncrease.effectiveAt,
          }
        : null,
    },
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}
