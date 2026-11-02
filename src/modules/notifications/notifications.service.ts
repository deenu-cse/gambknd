import { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { publish } from '../../realtime/bus.js';
import { AppError } from '../../utils/errors.js';
import { formatTokens } from '../../utils/money.js';
import { Notification, type INotification, type NotificationType } from './notification.model.js';

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read: boolean;
  createdAt: Date;
}

export function toNotificationView(n: INotification): NotificationView {
  return { id: n._id.toString(), type: n.type, title: n.title, body: n.body, data: n.data, read: n.read, createdAt: n.createdAt };
}

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  dedupeKey?: string;
}

/** Stores and pushes a notification. Best effort: a failed notice never fails the money operation behind it. */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    const doc = await Notification.create({
      userId: new Types.ObjectId(input.userId),
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? null,
      dedupeKey: input.dedupeKey ?? null,
    });
    await publish('notification.new', { userId: input.userId, notification: toNotificationView(doc.toObject()) });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return; // already sent for this event
    logger.warn({ err, type: input.type }, 'notification failed');
  }
}

export const tokens = (units: number): string => `${formatTokens(units)} tokens`;

export async function listNotifications(userId: string, q: { unreadOnly: boolean; cursor?: string; limit: number }): Promise<{ items: NotificationView[]; nextCursor: string | null; unread: number }> {
  const uid = new Types.ObjectId(userId);
  const filter: Record<string, unknown> = { userId: uid };
  if (q.unreadOnly) filter.read = false;
  if (q.cursor) filter._id = { $lt: new Types.ObjectId(q.cursor) };
  const [rows, unread] = await Promise.all([Notification.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean(), Notification.countDocuments({ userId: uid, read: false })]);
  const page = rows.slice(0, q.limit);
  return { items: page.map(toNotificationView), nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null, unread };
}

export async function markRead(userId: string, id: string): Promise<void> {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Notification');
  const res = await Notification.updateOne({ _id: id, userId: new Types.ObjectId(userId) }, { $set: { read: true } });
  if (res.matchedCount === 0) throw AppError.notFound('Notification');
}

export async function markAllRead(userId: string): Promise<number> {
  const res = await Notification.updateMany({ userId: new Types.ObjectId(userId), read: false }, { $set: { read: true } });
  return res.modifiedCount;
}
