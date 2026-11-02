import { Types, type ClientSession } from 'mongoose';
import { getContext } from '../../utils/requestContext.js';
import { AuditLog } from './audit.model.js';

export interface AuditActor {
  id: string | null;
  role: string;
  ip?: string | null;
}

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

export const SYSTEM_ACTOR: AuditActor = { id: null, role: 'system' };

/** Writes an audit record; pass `session` to make it part of the same transaction as the change. */
export async function recordAudit(actor: AuditActor, entry: AuditEntry, session?: ClientSession): Promise<void> {
  await AuditLog.create(
    [
      {
        actorId: actor.id ? new Types.ObjectId(actor.id) : null,
        actorRole: actor.role,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        reason: entry.reason ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        ip: actor.ip ?? null,
        requestId: getContext()?.requestId ?? null,
      },
    ],
    session ? { session } : {},
  );
}
