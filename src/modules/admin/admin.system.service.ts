import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { getRedis } from '../../config/redis.js';
import { readErrorRate } from '../../middleware/requestMetrics.js';
import { getHitBudget, getLiveClientStatus } from '../../providers/cricket/index.js';
import { IN_PROGRESS_STATUSES } from '../../providers/cricket/types.js';
import { getIo } from '../../realtime/socket.js';
import { pollerStatus } from '../../workers/poller.js';
import { getQueue, QUEUE_NAMES } from '../../workers/queues.js';
import { Match } from '../matches/match.model.js';
import { getSettings } from '../settings/settings.service.js';
import { listReconciliationRuns } from '../wallet/reconciliation.service.js';

export async function getProviderHealth() {
  const [settings, budget, poller, staleCount, liveCount] = await Promise.all([
    getSettings(),
    getHitBudget().usage(),
    pollerStatus(),
    Match.countDocuments({ stale: true }),
    Match.countDocuments({ status: { $in: IN_PROGRESS_STATUSES } }),
  ]);
  return {
    providerMode: settings.providerMode,
    liveConfigured: Boolean(env.CRICAPI_KEY),
    budget,
    circuit: getLiveClientStatus(),
    poller,
    matches: { inProgress: liveCount, stale: staleCount },
  };
}

async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; latencyMs: number }> {
  const started = performance.now();
  try {
    await fn();
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) };
  }
}

async function queueDepths() {
  return Promise.all(
    Object.values(QUEUE_NAMES).map(async (name) => {
      const c = await getQueue(name).getJobCounts('waiting', 'active', 'delayed', 'failed');
      return { name, waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 };
    }),
  );
}

async function socketCounts() {
  const io = getIo();
  if (!io) return { live: 0, user: 0, admin: 0 };
  const [live, user, admin] = await Promise.all(['/live', '/user', '/admin'].map(async (nsp) => (await io.of(nsp).fetchSockets()).length));
  return { live: live ?? 0, user: user ?? 0, admin: admin ?? 0 };
}

export async function getSystemHealth() {
  const [provider, mongo, redis, queues, sockets, errorRate, lastSynced, runs] = await Promise.all([
    getProviderHealth(),
    timed(async () => mongoose.connection.db?.command({ ping: 1 })),
    timed(() => getRedis().ping()),
    queueDepths(),
    socketCounts(),
    readErrorRate(),
    Match.findOne().sort({ lastSyncedAt: -1 }).select('lastSyncedAt').lean(),
    listReconciliationRuns(1),
  ]);
  const last = runs[0];
  return {
    provider,
    dependencies: { mongo, redis },
    queues,
    sockets,
    errorRate,
    lastSyncAt: lastSynced?.lastSyncedAt ?? null,
    lastReconciliation: last ? { id: last._id.toString(), status: last.status, startedAt: last.startedAt, mismatches: last.mismatches.length } : null,
    uptimeSec: Math.round(process.uptime()),
    generatedAt: new Date(),
  };
}
