import type { Request, Response } from 'express';
import type { z } from 'zod';
import { authOf, clientInfo } from '../../middleware/auth.js';
import { parseOrThrow } from '../../middleware/validate.js';
import { sendCreated, sendOk } from '../../utils/http.js';
import { adminBetsQuery, listBetsQuery, type placeBetSchema } from './bets.schema.js';
import { adminListBets, adminVoidOpenBet, getUserBet, listUserBets } from './bets.service.js';
import { executeCashout, getCashoutQuote } from './cashout.service.js';
import { placeBet } from './placement.service.js';

export async function place(req: Request, res: Response): Promise<void> {
  const { userId } = authOf(req);
  const { bet, duplicate } = await placeBet({ userId, ...clientInfo(req) }, req.body as z.infer<typeof placeBetSchema>);
  if (duplicate) sendOk(res, bet, { duplicate: true });
  else sendCreated(res, bet);
}

export async function list(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(listBetsQuery, req.query);
  const page = await listUserBets(authOf(req).userId, {
    bucket: q.status,
    limit: q.limit,
    ...(q.cursor ? { cursor: q.cursor } : {}),
    ...(q.matchId ? { matchId: q.matchId } : {}),
  });
  sendOk(res, page.items, { nextCursor: page.nextCursor, pageSize: q.limit });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  sendOk(res, await getUserBet(authOf(req).userId, String(req.params.id)));
}

export async function quote(req: Request, res: Response): Promise<void> {
  sendOk(res, await getCashoutQuote(authOf(req).userId, String(req.params.id)));
}

export async function cashout(req: Request, res: Response): Promise<void> {
  sendOk(res, await executeCashout(authOf(req).userId, String(req.params.id), (req.body as { quoteToken: string }).quoteToken));
}

export async function adminList(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(adminBetsQuery, req.query);
  const page = await adminListBets({
    limit: q.limit,
    ...(q.status ? { status: q.status } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.matchId ? { matchId: q.matchId } : {}),
    ...(q.marketId ? { marketId: q.marketId } : {}),
    ...(q.minStake ? { minStake: q.minStake } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  sendOk(res, page.items, { nextCursor: page.nextCursor, pageSize: q.limit });
}

export async function adminVoid(req: Request, res: Response): Promise<void> {
  const a = authOf(req);
  sendOk(res, await adminVoidOpenBet({ id: a.userId, role: a.role, ip: req.ip ?? null }, String(req.params.id), (req.body as { reason: string }).reason));
}
