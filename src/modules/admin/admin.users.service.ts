import { Types } from 'mongoose';
import { withTransaction } from '../../config/db.js';
import { getIo } from '../../realtime/socket.js';
import { AppError } from '../../utils/errors.js';
import { AuditLog } from '../audit/audit.model.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { revokeAllSessions } from '../auth/session.service.js';
import { Session } from '../auth/session.model.js';
import { Bet, OPEN_BET_STATUSES } from '../bets/bet.model.js';
import { User, isStaff, type IUser } from '../users/user.model.js';
import { toPublicUser } from '../users/user.serializer.js';
import { Wallet } from '../wallet/wallet.model.js';
import { getWalletSummary } from '../wallet/wallet.service.js';
import type { AdminUsersQuery } from './admin.schema.js';

const ID_PATTERN = /^[a-f0-9]{24}$/i;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function assertId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('User');
}

/** Staff can't be managed by their peers, and nobody can act on themselves. */
function assertCanManage(actor: AuditActor, target: Pick<IUser, '_id' | 'role'>): void {
  if (actor.id === target._id.toString()) throw new AppError('SELF_ACTION_FORBIDDEN', 'You cannot do this to your own account');
  if (isStaff(target.role) && actor.role !== 'superadmin') throw AppError.forbidden('Only a superadmin can manage staff accounts');
}

async function loadTarget(actor: AuditActor, id: string) {
  assertId(id);
  const user = await User.findById(id).lean();
  if (!user) throw AppError.notFound('User');
  assertCanManage(actor, user);
  return user;
}

/** Access tokens die through the revocation marker; open sockets have to be closed by hand. */
function dropSockets(userId: string): void {
  const io = getIo();
  if (!io) return;
  io.of('/user').in(`user:${userId}`).disconnectSockets(true);
  io.of('/admin').in(`user:${userId}`).disconnectSockets(true);
}

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: IUser['role'];
  status: IUser['status'];
  emailVerified: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  balance: number;
  locked: number;
}

export async function listUsers(q: AdminUsersQuery): Promise<{ items: AdminUserRow[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.role) filter.role = q.role;
  if (q.cursor) filter._id = { $lt: new Types.ObjectId(q.cursor) };
  if (q.q) {
    const rx = { $regex: escapeRegex(q.q), $options: 'i' };
    filter.$or = ID_PATTERN.test(q.q) ? [{ _id: new Types.ObjectId(q.q) }] : [{ name: rx }, { email: rx }];
  }
  const rows = await User.find(filter).sort({ _id: -1 }).limit(q.limit + 1).select('name email role status emailVerified lastLoginAt createdAt').lean();
  const page = rows.slice(0, q.limit);
  const wallets = await Wallet.find({ userId: { $in: page.map((u) => u._id) } }).select('userId balance lockedBalance').lean();
  const byUser = new Map(wallets.map((w) => [w.userId.toString(), w]));
  return {
    items: page.map((u) => {
      const w = byUser.get(u._id.toString());
      return {
        id: u._id.toString(), name: u.name, email: u.email, role: u.role, status: u.status, emailVerified: u.emailVerified,
        lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, balance: w?.balance ?? 0, locked: w?.lockedBalance ?? 0,
      };
    }),
    nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null,
  };
}

export async function getUserDetail(id: string) {
  assertId(id);
  const user = await User.findById(id).lean();
  if (!user) throw AppError.notFound('User');
  const oid = user._id;
  // Staff created outside registration have no wallet, and that isn't an error here.
  const [wallet, grouped, activeSessions] = await Promise.all([
    Wallet.exists({ userId: oid }).then((w) => (w ? getWalletSummary(id) : null)),
    Bet.aggregate<{ _id: string; count: number }>([{ $match: { userId: oid } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Session.countDocuments({ userId: oid, revokedAt: null, expiresAt: { $gt: new Date() } }),
  ]);
  const count = (status: string): number => grouped.find((g) => g._id === status)?.count ?? 0;
  return {
    user: { ...toPublicUser(user, { hasPassword: true }), statusReason: user.statusReason },
    wallet,
    stats: {
      bets: grouped.reduce((n, g) => n + g.count, 0),
      open: OPEN_BET_STATUSES.reduce((n, s) => n + count(s), 0),
      won: count('WON'),
      lost: count('LOST'),
      cashedOut: count('CASHED_OUT'),
      voided: count('VOID'),
      activeSessions,
    },
  };
}

export async function listUserSessions(id: string) {
  assertId(id);
  const rows = await Session.find({ userId: new Types.ObjectId(id) }).sort({ lastUsedAt: -1 }).limit(30).lean();
  return rows.map((s) => ({
    id: s._id.toString(), realm: s.realm, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt,
    expiresAt: s.expiresAt, revokedAt: s.revokedAt, revokeReason: s.revokeReason,
  }));
}

export async function listUserAudit(id: string) {
  assertId(id);
  const rows = await AuditLog.find({ targetType: 'user', targetId: id }).sort({ _id: -1 }).limit(50).lean();
  return rows.map((a) => ({ id: a._id.toString(), action: a.action, actorId: a.actorId?.toString() ?? null, actorRole: a.actorRole, reason: a.reason, before: a.before, after: a.after, ip: a.ip, createdAt: a.createdAt }));
}

export async function suspendUser(actor: AuditActor, id: string, reason: string) {
  const target = await loadTarget(actor, id);
  if (target.status === 'suspended') throw new AppError('INVALID_STATE', 'This account is already suspended');
  await withTransaction(async (session) => {
    // statusBeforeSuspend keeps a self-exclusion alive: lifting a suspension must never lift that too.
    const updated = await User.updateOne(
      { _id: target._id, status: target.status },
      { $set: { status: 'suspended', statusReason: reason, statusBeforeSuspend: target.status } },
      { session },
    );
    if (updated.modifiedCount !== 1) throw new AppError('CONFLICT', 'Account changed while suspending; retry');
    await recordAudit(actor, { action: 'user.suspend', targetType: 'user', targetId: id, reason, before: { status: target.status }, after: { status: 'suspended' } }, session);
  });
  await revokeAllSessions(id, 'suspended');
  dropSockets(id);
  return getUserDetail(id);
}

export async function unsuspendUser(actor: AuditActor, id: string, reason: string) {
  const target = await loadTarget(actor, id);
  if (target.status !== 'suspended') throw new AppError('INVALID_STATE', 'This account is not suspended');
  const restored = target.statusBeforeSuspend ?? 'active';
  await withTransaction(async (session) => {
    const updated = await User.updateOne(
      { _id: target._id, status: 'suspended' },
      { $set: { status: restored, statusReason: null, statusBeforeSuspend: null } },
      { session },
    );
    if (updated.modifiedCount !== 1) throw new AppError('CONFLICT', 'Account changed while unsuspending; retry');
    await recordAudit(actor, { action: 'user.unsuspend', targetType: 'user', targetId: id, reason, before: { status: 'suspended' }, after: { status: restored } }, session);
  });
  return getUserDetail(id);
}

export async function forceLogout(actor: AuditActor, id: string, reason: string) {
  await loadTarget(actor, id);
  const revoked = await revokeAllSessions(id, 'admin_force');
  dropSockets(id);
  await recordAudit(actor, { action: 'user.force_logout', targetType: 'user', targetId: id, reason, after: { revoked } });
  return { revoked };
}

/**
 * Clears daily stake/loss limits and any pending increase. Cool-offs and self-exclusion are left
 * alone: they are time-boxed protections the player chose, and an admin tool shouldn't undo them.
 */
export async function resetLimits(actor: AuditActor, id: string, reason: string) {
  const target = await loadTarget(actor, id);
  const { dailyStakeLimit, dailyLossLimit, pendingIncrease } = target.responsiblePlay;
  await withTransaction(async (session) => {
    await User.updateOne(
      { _id: target._id },
      { $set: { 'responsiblePlay.dailyStakeLimit': null, 'responsiblePlay.dailyLossLimit': null, 'responsiblePlay.pendingIncrease': null } },
      { session },
    );
    await recordAudit(actor, { action: 'user.reset_limits', targetType: 'user', targetId: id, reason, before: { dailyStakeLimit, dailyLossLimit, pendingIncrease }, after: { dailyStakeLimit: null, dailyLossLimit: null, pendingIncrease: null } }, session);
  });
  return getUserDetail(id);
}
