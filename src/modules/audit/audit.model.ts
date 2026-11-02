import { Schema, model, type Types } from 'mongoose';

/** Append-only record of privileged actions. Never updated or deleted by application code. */
export interface IAuditLog {
  _id: Types.ObjectId;
  actorId: Types.ObjectId | null; // null = system job
  actorRole: string;
  action: string; // e.g. "wallet.admin_credit", "user.suspend", "market.settle"
  targetType: string; // "user" | "market" | "bet" | "settings" | ...
  targetId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: Date;
}

const auditSchema = new Schema<IAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, default: null },
    reason: { type: String, default: null, maxlength: 1000 },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    requestId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ createdAt: -1 });
auditSchema.index({ actorId: 1, createdAt: -1 });
auditSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditSchema.index({ action: 1, createdAt: -1 });

export const AuditLog = model<IAuditLog>('AuditLog', auditSchema);
