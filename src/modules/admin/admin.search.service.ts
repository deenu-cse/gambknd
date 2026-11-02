import { Types } from 'mongoose';
import { AuditLog } from '../audit/audit.model.js';
import { User } from '../users/user.model.js';
import { LedgerEntry } from '../wallet/ledger.model.js';
import type { AuditQuery, LedgerQuery } from './admin.schema.js';

function dateRange(field: string, from?: Date, to?: Date): Record<string, unknown> {
  return from || to ? { [field]: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};
}

export async function searchLedger(q: LedgerQuery) {
  const filter: Record<string, unknown> = { ...dateRange('createdAt', q.from, q.to) };
  if (q.account) filter.account = q.account;
  if (q.userId) filter.userId = new Types.ObjectId(q.userId);
  if (q.type) filter.type = q.type;
  if (q.txnId) filter.txnId = q.txnId;
  if (q.refId) filter.refId = q.refId;
  if (q.idempotencyKey) filter.idempotencyKey = q.idempotencyKey;
  if (q.cursor) filter._id = { $lt: new Types.ObjectId(q.cursor) };
  const rows = await LedgerEntry.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((e) => ({
      id: e._id.toString(), txnId: e.txnId, account: e.account, userId: e.userId?.toString() ?? null, direction: e.direction, amount: e.amount,
      balanceAfter: e.balanceAfter, type: e.type, refType: e.refType, refId: e.refId, idempotencyKey: e.idempotencyKey,
      counterparty: e.counterparty, meta: e.meta, createdAt: e.createdAt,
    })),
    nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null,
  };
}

export async function searchAudit(q: AuditQuery) {
  const filter: Record<string, unknown> = { ...dateRange('createdAt', q.from, q.to) };
  if (q.action) filter.action = q.action;
  if (q.actorId) filter.actorId = new Types.ObjectId(q.actorId);
  if (q.targetType) filter.targetType = q.targetType;
  if (q.targetId) filter.targetId = q.targetId;
  if (q.cursor) filter._id = { $lt: new Types.ObjectId(q.cursor) };
  const rows = await AuditLog.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  const actors = await User.find({ _id: { $in: page.flatMap((a) => a.actorId ?? []) } }).select('name email').lean();
  const byId = new Map(actors.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));
  return {
    items: page.map((a) => ({
      id: a._id.toString(), action: a.action, actorId: a.actorId?.toString() ?? null, actorRole: a.actorRole,
      actor: a.actorId ? (byId.get(a.actorId.toString()) ?? null) : null, targetType: a.targetType, targetId: a.targetId, reason: a.reason,
      before: a.before, after: a.after, ip: a.ip, requestId: a.requestId, createdAt: a.createdAt,
    })),
    nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null,
  };
}

/** What the audit filters can offer. Read from the log so a new action appears without a code change. */
export async function auditFacets() {
  const [actions, targetTypes] = await Promise.all([AuditLog.distinct('action'), AuditLog.distinct('targetType')]);
  return { actions: actions.sort(), targetTypes: targetTypes.sort() };
}
