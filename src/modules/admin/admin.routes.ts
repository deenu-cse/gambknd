import { Router } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import { createLimiter, userKey } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validate.js';
import { adminAdjustmentSchema } from '../wallet/wallet.schema.js';
import * as admin from './admin.controller.js';
import { adminReasonSchema, settingsPatchSchema } from './admin.schema.js';
import * as wallet from './admin.wallet.controller.js';
import * as matches from './admin.matches.controller.js';
import * as markets from '../markets/markets.controller.js';
import * as bets from '../bets/bets.controller.js';
import { voidBetSchema } from '../bets/bets.schema.js';
import * as settlement from '../settlement/settlement.controller.js';
import { customMarketSchema, editMarketSchema, reasonSchema } from '../markets/markets.schema.js';

/** Everything under /api/admin except /api/admin/auth. Admin-realm token + staff role required. */
export function createAdminRouter(): Router {
  const r = Router();
  r.use(...requireAdmin);
  const moneyLimiter = createLimiter({ name: 'admin:money', windowMs: 60_000, limit: 30, key: userKey });

  r.get('/overview', admin.overview);
  r.get('/overview/charts', admin.charts);
  r.get('/risk', admin.risk);
  r.get('/ledger', admin.ledger);
  r.get('/audit', admin.audit);
  r.get('/audit/filters', admin.auditFilters);
  r.get('/settings', admin.settings);
  r.patch('/settings', validateBody(settingsPatchSchema), admin.updateSettings);
  r.get('/system/health', admin.systemHealth);

  r.get('/users', admin.listUsers);
  r.get('/users/:id', admin.getUser);
  r.get('/users/:id/sessions', admin.getUserSessions);
  r.get('/users/:id/audit', admin.getUserAudit);
  r.post('/users/:id/suspend', validateBody(adminReasonSchema), admin.suspend);
  r.post('/users/:id/unsuspend', validateBody(adminReasonSchema), admin.unsuspend);
  r.post('/users/:id/force-logout', validateBody(adminReasonSchema), admin.forceLogout);
  r.post('/users/:id/reset-limits', validateBody(adminReasonSchema), admin.resetLimits);
  r.get('/users/:id/wallet', wallet.getUserWallet);
  r.get('/users/:id/ledger', wallet.getUserLedger);
  r.post('/users/:id/credit', moneyLimiter, validateBody(adminAdjustmentSchema), wallet.postCredit);
  r.post('/users/:id/debit', moneyLimiter, validateBody(adminAdjustmentSchema), wallet.postDebit);

  r.get('/reconciliation/runs', wallet.getReconciliationRuns);
  r.get('/reconciliation/runs/:id', wallet.getReconciliationRunById);
  r.post('/reconciliation/run', createLimiter({ name: 'admin:recon', windowMs: 60_000, limit: 3, key: userKey }), wallet.postReconciliation);

  r.get('/replay/scripts', matches.listScripts);
  r.get('/replay/sessions', matches.listSessions);
  r.post('/replay/sessions', validateBody(matches.createReplaySchema), matches.createSession);
  r.post('/replay/sessions/:id/speed', validateBody(matches.replaySpeedSchema), matches.setSessionSpeed);
  r.post('/replay/sessions/:id/:action', matches.controlSession);
  r.get('/matches', admin.listMatches);
  r.get('/matches/:id', admin.getMatch);
  r.patch('/matches/:id', validateBody(matches.matchPatchSchema), matches.patchMatch);
  r.post('/matches/:id/resync', createLimiter({ name: 'admin:resync', windowMs: 60_000, limit: 10, key: userKey }), matches.resyncMatch);
  r.get('/system/provider', matches.providerHealth);

  r.get('/matches/:id/markets', markets.adminList);
  r.post('/matches/:id/markets', validateBody(customMarketSchema), markets.adminCreate);
  r.post('/matches/:id/markets/reevaluate', markets.adminReevaluate);
  r.patch('/markets/:id', validateBody(editMarketSchema), markets.adminEdit);
  r.post('/markets/:id/suspend', validateBody(reasonSchema), markets.adminSuspend);
  r.post('/markets/:id/reopen', validateBody(reasonSchema), markets.adminReopen);
  r.post('/markets/:id/close', validateBody(reasonSchema), markets.adminClose);

  r.post('/markets/:id/settle', moneyLimiter, validateBody(settlement.settleSchema), settlement.settle);
  r.post('/markets/:id/void', moneyLimiter, validateBody(settlement.voidSchema), settlement.voidMarket);
  r.post('/markets/:id/resettle', moneyLimiter, validateBody(settlement.settleSchema), settlement.resettle);
  r.get('/settlement/pending', settlement.pending);
  r.post('/settlement/catch-up', settlement.catchUp);
  r.post('/leaderboard/rebuild', settlement.rebuildBoards);

  r.get('/bets', bets.adminList);
  r.post('/bets/:id/void', moneyLimiter, validateBody(voidBetSchema), bets.adminVoid);
  return r;
}
