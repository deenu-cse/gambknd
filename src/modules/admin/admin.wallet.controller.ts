import type { Request, Response } from 'express';
import { authOf } from '../../middleware/auth.js';
import { parseOrThrow } from '../../middleware/validate.js';
import { AppError } from '../../utils/errors.js';
import { sendOk } from '../../utils/http.js';
import { recordAudit } from '../audit/audit.service.js';
import { getReconciliationRun, listReconciliationRuns, runReconciliation } from '../wallet/reconciliation.service.js';
import { transactionsQuerySchema, type AdminAdjustmentBody } from '../wallet/wallet.schema.js';
import { adminAdjust, getWalletSummary, listTransactions } from '../wallet/wallet.service.js';

function adjust(direction: 'credit' | 'debit') {
  return async (req: Request, res: Response): Promise<void> => {
    const auth = authOf(req);
    const body = req.body as AdminAdjustmentBody;
    const summary = await adminAdjust(
      { id: auth.userId, role: auth.role, ip: req.ip ?? null },
      { targetUserId: String(req.params.id), direction, ...body },
    );
    sendOk(res, summary);
  };
}

export const postCredit = adjust('credit');
export const postDebit = adjust('debit');

export async function getUserWallet(req: Request, res: Response): Promise<void> {
  sendOk(res, await getWalletSummary(String(req.params.id)));
}

export async function getUserLedger(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(transactionsQuerySchema, req.query);
  const page = await listTransactions(String(req.params.id), {
    limit: q.limit,
    ...(q.type ? { types: q.type } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
  sendOk(res, page.items, { nextCursor: page.nextCursor, pageSize: q.limit });
}

export async function postReconciliation(req: Request, res: Response): Promise<void> {
  const a = authOf(req);
  const run = await runReconciliation('manual', a.userId);
  await recordAudit({ id: a.userId, role: a.role, ip: req.ip ?? null }, { action: 'reconciliation.run', targetType: 'reconciliation', targetId: run._id.toString(), after: { status: run.status, mismatches: run.mismatches.length } });
  sendOk(res, run);
}

export async function getReconciliationRuns(_req: Request, res: Response): Promise<void> {
  sendOk(res, await listReconciliationRuns());
}

export async function getReconciliationRunById(req: Request, res: Response): Promise<void> {
  const run = await getReconciliationRun(String(req.params.id));
  if (!run) throw AppError.notFound('Reconciliation run');
  sendOk(res, run);
}
