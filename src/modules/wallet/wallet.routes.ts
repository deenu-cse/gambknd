import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createLimiter, userKey } from '../../middleware/rateLimit.js';
import * as c from './wallet.controller.js';

export function createWalletRouter(): Router {
  const r = Router();
  r.use(requireAuth('user'));
  r.get('/', c.getWallet);
  r.get('/transactions', c.getTransactions);
  r.post('/daily-bonus', createLimiter({ name: 'wallet:bonus', windowMs: 60_000, limit: 10, key: userKey }), c.postDailyBonus);
  return r;
}
