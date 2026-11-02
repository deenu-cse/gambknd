import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getRedis } from '../../config/redis.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { AppError } from '../../utils/errors.js';
import { User, type IUser } from '../users/user.model.js';
import { RefreshToken, Session, type Realm, type RevokeReason, type SessionDoc } from './session.model.js';
import { signAccessToken } from './tokens.js';

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
  userId: string;
}

const DAY_MS = 24 * 3600 * 1000;

function refreshTtlMs(realm: Realm): number {
  return (realm === 'admin' ? env.ADMIN_REFRESH_TTL_DAYS : env.REFRESH_TTL_DAYS) * DAY_MS;
}

const revokedKey = (sid: string): string => `auth:revoked:${sid}`;

async function issueRefreshToken(session: SessionDoc): Promise<{ token: string; id: Types.ObjectId }> {
  const token = randomToken(48);
  const doc = await RefreshToken.create({
    sessionId: session._id,
    userId: session.userId,
    tokenHash: sha256(token),
    expiresAt: session.expiresAt,
  });
  return { token, id: doc._id };
}

function accessFor(user: Pick<IUser, '_id' | 'role'>, session: SessionDoc): string {
  return signAccessToken({ sub: user._id.toString(), sid: session._id.toString(), role: user.role, realm: session.realm });
}

export async function createSession(user: Pick<IUser, '_id' | 'role'>, realm: Realm, client: ClientInfo): Promise<IssuedTokens> {
  const now = new Date();
  const session = await Session.create({
    userId: user._id,
    realm,
    ip: client.ip,
    userAgent: client.userAgent?.slice(0, 400) ?? null,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + refreshTtlMs(realm)),
  });
  const { token } = await issueRefreshToken(session);
  return { accessToken: accessFor(user, session), refreshToken: token, refreshExpiresAt: session.expiresAt, sessionId: session._id.toString(), userId: user._id.toString() };
}

/**
 * Refresh-token rotation with reuse detection. Each refresh token works once.
 * Presenting a used token means it leaked (or two tabs raced):
 *  - within REFRESH_REUSE_GRACE_SEC of its rotation → treat as a benign race (409, nothing revoked);
 *  - later → revoke the whole session family.
 */
export async function rotateRefreshToken(rawToken: string, realm: Realm, client: ClientInfo): Promise<IssuedTokens> {
  const tokenHash = sha256(rawToken);
  const existing = await RefreshToken.findOne({ tokenHash });
  if (!existing) throw new AppError('INVALID_REFRESH_TOKEN', 'Session expired, please log in again');

  const session = await Session.findById(existing.sessionId);
  if (!session || session.realm !== realm || session.revokedAt || session.expiresAt <= new Date()) {
    throw new AppError('INVALID_REFRESH_TOKEN', 'Session expired, please log in again');
  }

  const now = new Date();
  // Atomically claim the token so two concurrent refreshes can't both succeed.
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: existing._id, usedAt: null },
    { $set: { usedAt: now } },
    { new: true },
  );
  if (!claimed) {
    const usedAt = existing.usedAt ?? now;
    if (now.getTime() - usedAt.getTime() <= env.REFRESH_REUSE_GRACE_SEC * 1000) {
      throw new AppError('REFRESH_CONFLICT', 'Session was refreshed by another request; retry');
    }
    logger.warn({ sessionId: session._id.toString(), userId: session.userId.toString() }, 'refresh token reuse detected, revoking session');
    await revokeSession(session._id.toString(), 'reuse_detected');
    throw new AppError('REFRESH_TOKEN_REUSED', 'Session revoked for security reasons, please log in again');
  }

  const user = await User.findById(session.userId).select('role status');
  if (!user || user.status === 'suspended') {
    await revokeSession(session._id.toString(), 'suspended');
    throw new AppError('ACCOUNT_SUSPENDED', 'Account is suspended');
  }
  if (realm === 'admin' && user.role === 'user') {
    await revokeSession(session._id.toString(), 'admin_force');
    throw AppError.forbidden('Admin access required');
  }

  const next = await issueRefreshToken(session);
  claimed.replacedBy = next.id;
  await claimed.save();
  session.lastUsedAt = now;
  session.ip = client.ip;
  session.userAgent = client.userAgent?.slice(0, 400) ?? session.userAgent;
  await session.save();

  return {
    accessToken: accessFor(user, session),
    refreshToken: next.token,
    refreshExpiresAt: session.expiresAt,
    sessionId: session._id.toString(),
    userId: user._id.toString(),
  };
}

async function markRevokedInCache(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  // Access tokens are stateless; this marker kills them before their 15-min expiry.
  const pipeline = getRedis().pipeline();
  for (const sid of sessionIds) pipeline.set(revokedKey(sid), '1', 'EX', env.JWT_ACCESS_TTL_SEC + 60);
  await pipeline.exec();
}

export async function revokeSession(sessionId: string, reason: RevokeReason): Promise<void> {
  if (!Types.ObjectId.isValid(sessionId)) return;
  await Session.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });
  await markRevokedInCache([sessionId]);
}

export async function revokeAllSessions(
  userId: string,
  reason: RevokeReason,
  opts: { realm?: Realm; exceptSessionId?: string } = {},
): Promise<number> {
  const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId), revokedAt: null };
  if (opts.realm) filter.realm = opts.realm;
  if (opts.exceptSessionId) filter._id = { $ne: new Types.ObjectId(opts.exceptSessionId) };
  const sessions = await Session.find(filter).select('_id').lean();
  const ids = sessions.map((s) => s._id.toString());
  if (ids.length === 0) return 0;
  await Session.updateMany({ _id: { $in: sessions.map((s) => s._id) } }, { $set: { revokedAt: new Date(), revokeReason: reason } });
  await markRevokedInCache(ids);
  return ids.length;
}

export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  return (await getRedis().exists(revokedKey(sessionId))) === 1;
}

export interface SessionView {
  id: string;
  realm: Realm;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  current: boolean;
}

export async function listActiveSessions(userId: string, currentSessionId?: string): Promise<SessionView[]> {
  const sessions = await Session.find({ userId: new Types.ObjectId(userId), revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastUsedAt: -1 })
    .lean();
  return sessions.map((s) => ({
    id: s._id.toString(),
    realm: s.realm,
    ip: s.ip,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    current: s._id.toString() === currentSessionId,
  }));
}

export async function revokeOwnSession(userId: string, sessionId: string): Promise<void> {
  if (!Types.ObjectId.isValid(sessionId)) throw AppError.notFound('Session');
  const session = await Session.findOne({ _id: sessionId, userId: new Types.ObjectId(userId), revokedAt: null });
  if (!session) throw AppError.notFound('Session');
  await revokeSession(sessionId, 'logout');
}
