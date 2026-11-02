import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createLimiter, userKey } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validate.js';
import * as c from './bets.controller.js';
import { cashoutSchema, placeBetSchema } from './bets.schema.js';

export function createBetsRouter(): Router {
  const r = Router();
  r.use(requireAuth('user'));
  // 10 bets per 10 seconds per user (spec §8).
  const placeLimiter = createLimiter({ name: 'bets:place', windowMs: 10_000, limit: 10, key: userKey });
  const cashoutLimiter = createLimiter({ name: 'bets:cashout', windowMs: 10_000, limit: 20, key: userKey });
  r.post('/', placeLimiter, validateBody(placeBetSchema), c.place);
  r.get('/', c.list);
  r.get('/:id', c.getOne);
  r.get('/:id/cashout-quote', cashoutLimiter, c.quote);
  r.post('/:id/cashout', cashoutLimiter, validateBody(cashoutSchema), c.cashout);
  return r;
}
