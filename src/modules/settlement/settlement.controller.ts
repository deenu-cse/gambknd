import type { Request, Response } from 'express';
import { z } from 'zod';
import { authOf } from '../../middleware/auth.js';
import { sendOk } from '../../utils/http.js';
import { recordAudit } from '../audit/audit.service.js';
import { rebuildLeaderboards } from '../leaderboard/leaderboard.service.js';
import { Market } from '../markets/market.model.js';
import { toAdminMarketView } from '../markets/market.views.js';
import { Match } from '../matches/match.model.js';
import { resettleMarket } from './resettle.service.js';
import { manualSettle, settlementCatchUp } from './settlement.service.js';

const reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500);
export const settleSchema = z
  .object({ winningSelectionIds: z.array(z.string().min(1).max(60)).min(1).max(40).optional(), void: z.boolean().optional(), settledValue: z.number().int().nullable().optional(), reason })
  .strict()
  .refine((v) => v.void === true || (v.winningSelectionIds?.length ?? 0) > 0, 'Choose winners or void');
export const voidSchema = z.object({ reason }).strict();

const actor = (req: Request) => {
  const a = authOf(req);
  return { id: a.userId, role: a.role, ip: req.ip ?? null };
};

export async function settle(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof settleSchema>;
  const m = await manualSettle(actor(req), String(req.params.id), body);
  sendOk(res, toAdminMarketView(m, null));
}

export async function voidMarket(req: Request, res: Response): Promise<void> {
  const m = await manualSettle(actor(req), String(req.params.id), { void: true, reason: (req.body as { reason: string }).reason });
  sendOk(res, toAdminMarketView(m, null));
}

export async function resettle(req: Request, res: Response): Promise<void> {
  const report = await resettleMarket(actor(req), String(req.params.id), req.body as z.infer<typeof settleSchema>);
  sendOk(res, { market: toAdminMarketView(report.market, null), betsReopened: report.betsReopened, betsResettled: report.betsResettled });
}

/** Manual-settlement queue: closed markets on finished matches the resolvers couldn't decide. */
export async function pending(_req: Request, res: Response): Promise<void> {
  const finished = await Match.find({ status: { $in: ['COMPLETED', 'ABANDONED', 'NO_RESULT'] } }).select('_id title status statusText').sort({ endedAt: -1 }).limit(200).lean();
  const byId = new Map(finished.map((m) => [m._id.toString(), m]));
  const markets = await Market.find({ matchId: { $in: finished.map((m) => m._id) }, status: 'CLOSED', result: null }).sort({ updatedAt: -1 }).limit(200).lean();
  sendOk(res, markets.map((m) => ({ market: toAdminMarketView(m, null), match: byId.get(m.matchId.toString()) ?? null })));
}

export async function catchUp(req: Request, res: Response): Promise<void> {
  const result = await settlementCatchUp();
  await recordAudit(actor(req), { action: 'settlement.catch_up', targetType: 'settlement', after: result });
  sendOk(res, result);
}

export async function rebuildBoards(req: Request, res: Response): Promise<void> {
  const betsReplayed = await rebuildLeaderboards();
  await recordAudit(actor(req), { action: 'leaderboard.rebuild', targetType: 'leaderboard', after: { betsReplayed } });
  sendOk(res, { betsReplayed });
}
