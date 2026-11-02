import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { optionalAuth } from '../../middleware/auth.js';
import { parseOrThrow } from '../../middleware/validate.js';
import { sendOk } from '../../utils/http.js';
import { getLeaderboard, ROI_MIN_BETS, ROI_MIN_STAKED } from './leaderboard.service.js';

const query = z
  .object({
    period: z.enum(['daily', 'weekly', 'all']).default('weekly'),
    metric: z.enum(['profit', 'roi']).default('profit'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/** Public; when the caller is logged in, their own row (and rank) comes back as `me`. */
export function createLeaderboardRouter(): Router {
  const r = Router();
  r.get('/', optionalAuth('user'), async (req: Request, res: Response) => {
    const q = parseOrThrow(query, req.query);
    const board = await getLeaderboard(q.period, q.metric, q.limit, req.auth?.userId);
    sendOk(res, board, { period: q.period, metric: q.metric, roiMinBets: ROI_MIN_BETS, roiMinStaked: ROI_MIN_STAKED });
  });
  return r;
}
