import { Worker, type Job } from 'bullmq';
import { logger } from '../config/logger.js';
import { createQueueConnection } from '../config/redis.js';
import { runReconciliation } from '../modules/wallet/reconciliation.service.js';
import { Wallet } from '../modules/wallet/wallet.model.js';
import { notify } from '../modules/notifications/notifications.service.js';
import { getQueue, QUEUE_NAMES } from './queues.js';

export const MAINTENANCE_JOBS = {
  reconcile: 'reconcile',
  bonusReminders: 'bonus-reminders',
} as const;

/** Tells users whose daily bonus became claimable in the last hour. Deduped per claim. */
export async function sendBonusReminders(now = Date.now()): Promise<number> {
  const from = new Date(now - 25 * 3600 * 1000);
  const to = new Date(now - 24 * 3600 * 1000);
  let sent = 0;
  for await (const w of Wallet.find({ lastDailyBonusAt: { $gte: from, $lt: to } }).select('userId lastDailyBonusAt').lean().cursor()) {
    await notify({
      userId: w.userId.toString(),
      type: 'BONUS_AVAILABLE',
      title: 'Daily bonus ready',
      body: 'Your daily play-token bonus is ready to claim in your wallet.',
      dedupeKey: `bonus:${w.userId.toString()}:${w.lastDailyBonusAt?.toISOString() ?? ''}`,
    });
    sent += 1;
  }
  return sent;
}

async function processMaintenance(job: Job): Promise<unknown> {
  switch (job.name) {
    case MAINTENANCE_JOBS.reconcile: {
      const run = await runReconciliation('scheduled');
      return { runId: run._id.toString(), status: run.status, mismatches: run.mismatches.length };
    }
    case MAINTENANCE_JOBS.bonusReminders:
      return { sent: await sendBonusReminders() };
    default:
      throw new Error(`unknown maintenance job: ${job.name}`);
  }
}

/** Nightly reconciliation at 03:00 UTC. Upserting the scheduler is idempotent across restarts. */
export async function scheduleMaintenance(): Promise<void> {
  await getQueue(QUEUE_NAMES.maintenance).upsertJobScheduler(
    'nightly-reconcile',
    { pattern: '0 3 * * *', tz: 'UTC' },
    { name: MAINTENANCE_JOBS.reconcile, data: {} },
  );
  await getQueue(QUEUE_NAMES.maintenance).upsertJobScheduler('hourly-bonus-reminders', { pattern: '0 * * * *', tz: 'UTC' }, { name: MAINTENANCE_JOBS.bonusReminders, data: {} });
}

export function startMaintenanceWorker(): Worker {
  const worker = new Worker(QUEUE_NAMES.maintenance, processMaintenance, {
    connection: createQueueConnection('worker:maintenance'),
    concurrency: 1,
  });
  worker.on('completed', (job, result) => logger.info({ job: job.name, result }, 'maintenance job done'));
  worker.on('failed', (job, err) => logger.error({ job: job?.name, err }, 'maintenance job failed'));
  return worker;
}
