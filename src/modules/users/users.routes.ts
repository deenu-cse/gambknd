import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createLimiter, userKey } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validate.js';
import * as c from './users.controller.js';
import {
  changePasswordSchema,
  responsiblePlaySchema,
  selfExcludeSchema,
  takeBreakSchema,
  updatePreferencesSchema,
  updateProfileSchema,
} from './users.schema.js';

export function createUsersRouter(): Router {
  const r = Router();
  r.use(requireAuth('user'));
  const sensitive = createLimiter({ name: 'users:sensitive', windowMs: 15 * 60_000, limit: 10, key: userKey });

  r.get('/me', c.getMe);
  r.patch('/me', validateBody(updateProfileSchema), c.patchMe);
  r.patch('/me/preferences', validateBody(updatePreferencesSchema), c.patchPreferences);
  r.put('/me/responsible-play', validateBody(responsiblePlaySchema), c.putResponsiblePlay);
  r.post('/me/break', validateBody(takeBreakSchema), c.postBreak);
  r.post('/me/self-exclude', validateBody(selfExcludeSchema), c.postSelfExclude);
  r.post('/me/password', sensitive, validateBody(changePasswordSchema), c.postPassword);
  r.get('/me/sessions', c.getSessions);
  r.delete('/me/sessions/:id', c.deleteSession);
  return r;
}
