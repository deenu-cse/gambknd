import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { authOf } from '../../middleware/auth.js';
import { getReplayStore, providerFor, ProviderError } from '../../providers/cricket/index.js';
import { replayScripts } from '../../providers/cricket/replay/scripts.js';
import type { ReplayAction } from '../../providers/cricket/replay/sessions.js';
import { AppError } from '../../utils/errors.js';
import { sendOk } from '../../utils/http.js';
import { recordAudit } from '../audit/audit.service.js';
import { invalidateLiveView } from '../matches/matchCache.js';
import { Match } from '../matches/match.model.js';
import { syncMatch } from '../matches/sync.service.js';
import { reevaluateMatch } from '../markets/engine.js';
import { getProviderHealth } from './admin.system.service.js';
import { env } from '../../config/env.js';

export const createReplaySchema = z
  .object({
    scriptId: z.string().min(1).max(100),
    /** Milliseconds per delivery. 5000 = one ball every 5s. */
    intervalMs: z.number().int().min(250).max(60_000).default(env.REPLAY_BALL_INTERVAL_MS),
    /** Pre-match window so pre-match markets can be traded before the toss. */
    startInSec: z.number().int().min(0).max(24 * 3600).default(300),
  })
  .strict();
export const replaySpeedSchema = z.object({ intervalMs: z.number().int().min(250).max(60_000) }).strict();
export const matchPatchSchema = z.object({ bettingEnabled: z.boolean().optional(), featured: z.boolean().optional(), reason: z.string().trim().min(3).max(300) }).strict();

const ACTIONS: readonly ReplayAction[] = ['start', 'pause', 'rain', 'resume', 'abandon', 'finish', 'outage_on', 'outage_off'];

const actor = (req: Request) => {
  const a = authOf(req);
  return { id: a.userId, role: a.role, ip: req.ip ?? null };
};

export function listScripts(_req: Request, res: Response): void {
  sendOk(
    res,
    replayScripts().map((s) => ({
      id: s.id, title: s.title, format: s.format, scheduledOvers: s.scheduledOvers,
      teams: s.teams.map((t) => t.name), result: s.resultText, scoreSynthesized: s.scoreSynthesized,
    })),
  );
}

export async function listSessions(_req: Request, res: Response): Promise<void> {
  const sessions = await getReplayStore().list(50);
  const matches = await Match.find({ source: 'replay', 'providerRef.id': { $in: sessions.map((s) => s.providerId) } }).select('providerRef status').lean();
  const byPid = new Map(matches.map((m) => [m.providerRef.id, { matchId: m._id.toString(), status: m.status }]));
  sendOk(res, sessions.map((s) => ({ ...s, match: byPid.get(s.providerId) ?? null })));
}

export async function createSession(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof createReplaySchema>;
  if (!replayScripts().some((s) => s.id === body.scriptId)) throw AppError.notFound('Replay script');
  const session = await getReplayStore().create(body);
  await recordAudit(actor(req), { action: 'replay.create', targetType: 'replay', targetId: session.id, after: body });
  sendOk(res, session, undefined, 201);
}

export async function controlSession(req: Request, res: Response): Promise<void> {
  const action = String(req.params.action) as ReplayAction;
  if (!ACTIONS.includes(action)) throw AppError.badRequest(`Unknown action; use one of ${ACTIONS.join(', ')}`);
  const store = getReplayStore();
  if (!(await store.get(String(req.params.id)))) throw AppError.notFound('Replay session');
  const session = await store.control(String(req.params.id), action);
  await recordAudit(actor(req), { action: `replay.${action}`, targetType: 'replay', targetId: session.id });
  sendOk(res, session);
}

export async function setSessionSpeed(req: Request, res: Response): Promise<void> {
  const store = getReplayStore();
  if (!(await store.get(String(req.params.id)))) throw AppError.notFound('Replay session');
  const { intervalMs } = req.body as { intervalMs: number };
  const session = await store.setSpeed(String(req.params.id), intervalMs);
  await recordAudit(actor(req), { action: 'replay.speed', targetType: 'replay', targetId: session.id, after: { intervalMs } });
  sendOk(res, session);
}

export async function patchMatch(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Match');
  const { reason, ...patch } = req.body as z.infer<typeof matchPatchSchema>;
  const before = await Match.findById(id).select('bettingEnabled featured').lean();
  if (!before) throw AppError.notFound('Match');
  await Match.updateOne({ _id: id }, { $set: patch });
  await invalidateLiveView(id);
  // Betting switched on/off: markets follow immediately (BETTING_DISABLED suspension).
  if (patch.bettingEnabled !== undefined) await reevaluateMatch(id);
  await recordAudit(actor(req), { action: 'match.update', targetType: 'match', targetId: id, reason, before: { bettingEnabled: before.bettingEnabled, featured: before.featured }, after: patch });
  sendOk(res, { id, ...patch });
}

/** Pull the latest state from the provider now (costs one or two hits in live mode). */
export async function resyncMatch(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Match');
  const match = await Match.findById(id).lean();
  if (!match) throw AppError.notFound('Match');
  const provider = providerFor(match.source);
  if (!provider) throw new AppError('SERVICE_UNAVAILABLE', 'Provider for this match is not configured');
  try {
    const detail = await provider.getMatchDetail(match.providerRef.id);
    const balls = detail.capabilities.ballByBall && provider.capabilities().ballByBall ? await provider.getBallByBall(match.providerRef.id) : [];
    const change = await syncMatch(detail, { balls });
    await recordAudit(actor(req), { action: 'match.resync', targetType: 'match', targetId: id });
    sendOk(res, { changed: change !== null, status: detail.status });
  } catch (err) {
    if (err instanceof ProviderError) throw new AppError('PROVIDER_UNAVAILABLE', err.message, { kind: err.kind });
    throw err;
  }
}

export async function providerHealth(_req: Request, res: Response): Promise<void> {
  sendOk(res, await getProviderHealth());
}
