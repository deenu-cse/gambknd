import type { Request, Response } from 'express';
import { authOf } from '../../middleware/auth.js';
import { sendOk } from '../../utils/http.js';
import { listActiveSessions, revokeOwnSession } from '../auth/session.service.js';
import * as users from './users.service.js';
import type { z } from 'zod';
import type {
  changePasswordSchema,
  responsiblePlaySchema,
  selfExcludeSchema,
  takeBreakSchema,
  updatePreferencesSchema,
  updateProfileSchema,
} from './users.schema.js';

export async function getMe(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.getProfile(authOf(req).userId));
}

export async function patchMe(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.updateProfile(authOf(req).userId, req.body as z.infer<typeof updateProfileSchema>));
}

export async function patchPreferences(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.updatePreferences(authOf(req).userId, req.body as z.infer<typeof updatePreferencesSchema>));
}

export async function putResponsiblePlay(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.setResponsiblePlay(authOf(req).userId, req.body as z.infer<typeof responsiblePlaySchema>));
}

export async function postBreak(req: Request, res: Response): Promise<void> {
  const { duration } = req.body as z.infer<typeof takeBreakSchema>;
  sendOk(res, await users.takeBreak(authOf(req).userId, duration));
}

export async function postSelfExclude(req: Request, res: Response): Promise<void> {
  const { duration } = req.body as z.infer<typeof selfExcludeSchema>;
  sendOk(res, await users.selfExclude(authOf(req).userId, duration));
}

export async function postPassword(req: Request, res: Response): Promise<void> {
  const { userId, sessionId } = authOf(req);
  await users.changePassword(userId, sessionId, req.body as z.infer<typeof changePasswordSchema>);
  sendOk(res, { changed: true });
}

export async function getSessions(req: Request, res: Response): Promise<void> {
  const { userId, sessionId } = authOf(req);
  sendOk(res, await listActiveSessions(userId, sessionId));
}

export async function deleteSession(req: Request, res: Response): Promise<void> {
  await revokeOwnSession(authOf(req).userId, String(req.params.id));
  sendOk(res, { revoked: true });
}
