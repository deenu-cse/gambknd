import { Router, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { parseOrThrow } from '../../middleware/validate.js';
import { sendOk } from '../../utils/http.js';
import { listNotifications, markAllRead, markRead } from './notifications.service.js';

const listQuery = z
  .object({
    unread: z.enum(['true', 'false']).default('false'),
    cursor: z.string().refine((v) => Types.ObjectId.isValid(v), 'invalid cursor').optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export function createNotificationsRouter(): Router {
  const r = Router();
  r.use(requireAuth('user'));
  r.get('/', async (req: Request, res: Response) => {
    const q = parseOrThrow(listQuery, req.query);
    const page = await listNotifications(authOf(req).userId, { unreadOnly: q.unread === 'true', limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
    sendOk(res, page.items, { nextCursor: page.nextCursor, unread: page.unread });
  });
  r.post('/read-all', async (req: Request, res: Response) => {
    sendOk(res, { updated: await markAllRead(authOf(req).userId) });
  });
  r.post('/:id/read', async (req: Request, res: Response) => {
    await markRead(authOf(req).userId, String(req.params.id));
    sendOk(res, { read: true });
  });
  return r;
}
