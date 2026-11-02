import type { Request, Response } from 'express';
import { authOf } from '../../middleware/auth.js';
import { parseOrThrow } from '../../middleware/validate.js';
import { sendOk } from '../../utils/http.js';
import { transactionsQuerySchema } from './wallet.schema.js';
import * as wallet from './wallet.service.js';

export async function getWallet(req: Request, res: Response): Promise<void> {
  sendOk(res, await wallet.getWalletSummary(authOf(req).userId));
}

export async function postDailyBonus(req: Request, res: Response): Promise<void> {
  sendOk(res, await wallet.claimDailyBonus(authOf(req).userId));
}

export async function getTransactions(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(transactionsQuerySchema, req.query);
  const page = await wallet.listTransactions(authOf(req).userId, {
    limit: q.limit,
    ...(q.type ? { types: q.type } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  sendOk(res, page.items, { nextCursor: page.nextCursor, pageSize: q.limit });
}
