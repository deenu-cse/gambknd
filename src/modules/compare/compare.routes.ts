import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLimiter } from '../../middleware/rateLimit.js';
import { parseOrThrow } from '../../middleware/validate.js';
import { sendOk } from '../../utils/http.js';
import { comparePlayers, compareTeams } from './compare.service.js';

const teamKey = z.string().regex(/^[a-z0-9-]{1,80}$/);
const teamsQuery = z.object({ a: teamKey, b: teamKey, venue: z.string().trim().min(2).max(120).optional() }).strict();
const playersQuery = z.object({ a: z.string().min(1).max(80), b: z.string().min(1).max(80), format: z.enum(['T20', 'ODI', 'TEST']).default('T20') }).strict();

export function createCompareRouter(): Router {
  const r = Router();
  r.get('/teams', async (req: Request, res: Response) => {
    const q = parseOrThrow(teamsQuery, req.query);
    sendOk(res, await compareTeams(q.a, q.b, q.venue));
  });
  // Player stats may hit the provider on a cache miss (budgeted), so this route is rate limited.
  r.get('/players', createLimiter({ name: 'compare:players', windowMs: 60_000, limit: 20 }), async (req: Request, res: Response) => {
    const q = parseOrThrow(playersQuery, req.query);
    sendOk(res, await comparePlayers(q.a, q.b, q.format));
  });
  return r;
}
