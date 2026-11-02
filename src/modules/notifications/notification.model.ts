import { Schema, model, type Types } from 'mongoose';

export const NOTIFICATION_TYPES = ['BET_SETTLED', 'BET_REJECTED', 'BET_RESETTLED', 'BET_VOIDED', 'CASHOUT', 'BONUS_AVAILABLE', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'SYSTEM'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface INotification {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read: boolean;
  /** Prevents duplicates for the same event (e.g. one settlement notice per bet per round). */
  dedupeKey: string | null;
  createdAt: Date;
}

const schema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 500 },
    data: { type: Schema.Types.Mixed, default: null },
    read: { type: Boolean, default: false },
    dedupeKey: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ userId: 1, createdAt: -1 });
schema.index({ userId: 1, read: 1 });
schema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
// Keep 90 days of notifications.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export const Notification = model<INotification>('Notification', schema);
