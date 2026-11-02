import type { Request, Response } from 'express';
import { authOf } from '../../middleware/auth.js';
import { parseOrThrow } from '../../middleware/validate.js';
import { sendOk } from '../../utils/http.js';
import { getSettings } from '../settings/settings.service.js';
import { adminGetMatch, adminListMatches } from './admin.matches.service.js';
import { getCharts, getOverview } from './admin.overview.service.js';
import { getRisk } from './admin.risk.service.js';
import { adminMatchesQuery, adminUsersQuery, auditQuery, chartsQuery, ledgerQuery, riskQuery, type SettingsPatchBody } from './admin.schema.js';
import { auditFacets, searchAudit, searchLedger } from './admin.search.service.js';
import { patchSettings } from './admin.settings.service.js';
import { getSystemHealth } from './admin.system.service.js';
import * as users from './admin.users.service.js';

const actor = (req: Request) => {
  const a = authOf(req);
  return { id: a.userId, role: a.role, ip: req.ip ?? null };
};
const idOf = (req: Request): string => String(req.params.id);
const reasonOf = (req: Request): string => (req.body as { reason: string }).reason;

export async function overview(_req: Request, res: Response): Promise<void> {
  sendOk(res, await getOverview());
}

export async function charts(req: Request, res: Response): Promise<void> {
  sendOk(res, await getCharts(parseOrThrow(chartsQuery, req.query).days));
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(adminUsersQuery, req.query);
  const page = await users.listUsers(q);
  sendOk(res, page.items, { nextCursor: page.nextCursor, pageSize: q.limit });
}

export async function getUser(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.getUserDetail(idOf(req)));
}

export async function getUserSessions(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.listUserSessions(idOf(req)));
}

export async function getUserAudit(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.listUserAudit(idOf(req)));
}

export async function suspend(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.suspendUser(actor(req), idOf(req), reasonOf(req)));
}

export async function unsuspend(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.unsuspendUser(actor(req), idOf(req), reasonOf(req)));
}

export async function forceLogout(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.forceLogout(actor(req), idOf(req), reasonOf(req)));
}

export async function resetLimits(req: Request, res: Response): Promise<void> {
  sendOk(res, await users.resetLimits(actor(req), idOf(req), reasonOf(req)));
}

export async function listMatches(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(adminMatchesQuery, req.query);
  const page = await adminListMatches(q);
  sendOk(res, page.items, { nextCursor: page.nextCursor, pageSize: q.limit });
}

export async function getMatch(req: Request, res: Response): Promise<void> {
  sendOk(res, await adminGetMatch(idOf(req)));
}

export async function risk(req: Request, res: Response): Promise<void> {
  sendOk(res, await getRisk(parseOrThrow(riskQuery, req.query)));
}

export async function ledger(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(ledgerQuery, req.query);
  const page = await searchLedger(q);
  sendOk(res, page.items, { nextCursor: page.nextCursor, pageSize: q.limit });
}

export async function audit(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(auditQuery, req.query);
  const page = await searchAudit(q);
  sendOk(res, page.items, { nextCursor: page.nextCursor, pageSize: q.limit });
}

export async function auditFilters(_req: Request, res: Response): Promise<void> {
  sendOk(res, await auditFacets());
}

export async function settings(_req: Request, res: Response): Promise<void> {
  sendOk(res, await getSettings());
}

export async function updateSettings(req: Request, res: Response): Promise<void> {
  sendOk(res, await patchSettings(actor(req), req.body as SettingsPatchBody));
}

export async function systemHealth(_req: Request, res: Response): Promise<void> {
  sendOk(res, await getSystemHealth());
}
