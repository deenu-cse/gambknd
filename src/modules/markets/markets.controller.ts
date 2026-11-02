import type { Request, Response } from 'express';
import type { z } from 'zod';
import { authOf } from '../../middleware/auth.js';
import { sendCreated, sendOk } from '../../utils/http.js';
import { recordAudit } from '../audit/audit.service.js';
import { reevaluateMatch } from './engine.js';
import * as markets from './market.service.js';
import type { customMarketSchema, editMarketSchema } from './markets.schema.js';

const actor = (req: Request) => {
  const a = authOf(req);
  return { id: a.userId, role: a.role, ip: req.ip ?? null };
};
const reasonOf = (req: Request): string => (req.body as { reason: string }).reason;

export async function listForMatch(req: Request, res: Response): Promise<void> {
  sendOk(res, await markets.listMatchMarkets(String(req.params.id)));
}

export async function getOne(req: Request, res: Response): Promise<void> {
  sendOk(res, await markets.getMarket(String(req.params.id)));
}

export async function adminList(req: Request, res: Response): Promise<void> {
  sendOk(res, await markets.adminListMatchMarkets(String(req.params.id)));
}

export async function adminCreate(req: Request, res: Response): Promise<void> {
  sendCreated(res, await markets.createCustomMarket(actor(req), String(req.params.id), req.body as z.infer<typeof customMarketSchema>));
}

export async function adminEdit(req: Request, res: Response): Promise<void> {
  sendOk(res, await markets.editMarket(actor(req), String(req.params.id), req.body as z.infer<typeof editMarketSchema>));
}

export async function adminSuspend(req: Request, res: Response): Promise<void> {
  sendOk(res, await markets.suspendMarket(actor(req), String(req.params.id), reasonOf(req)));
}

export async function adminReopen(req: Request, res: Response): Promise<void> {
  sendOk(res, await markets.reopenMarket(actor(req), String(req.params.id), reasonOf(req)));
}

export async function adminClose(req: Request, res: Response): Promise<void> {
  sendOk(res, await markets.closeMarket(actor(req), String(req.params.id), reasonOf(req)));
}

export async function adminReevaluate(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const result = await reevaluateMatch(id);
  await recordAudit(actor(req), { action: 'market.reevaluate', targetType: 'match', targetId: id });
  sendOk(res, result);
}

export async function featured(req: Request, res: Response): Promise<void> {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 8) || 8));
  sendOk(res, await markets.listFeatured(limit));
}
