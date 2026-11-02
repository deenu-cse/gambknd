import { Worker, type Job } from 'bullmq';
import { logger } from '../config/logger.js';
import { createQueueConnection } from '../config/redis.js';
import type { SettlementScheduler } from '../modules/settlement/settlement.handler.js';
import { autoSettleMatch, settlementCatchUp } from '../modules/settlement/settlement.service.js';
import { getQueue, QUEUE_NAMES } from './queues.js';

/**
 * One settle job per match per 2-second window: bursts of changes collapse into one run, and a
 * change that arrives while a run is active still gets its own job in the next window.
 */
export const bullmqSettlementScheduler: SettlementScheduler = async (matchId) => {
  await getQueue(QUEUE_NAMES.settlement).add('settle-match', { matchId }, { jobId: `settle-${matchId}-${Math.floor(Date.now() / 2000)}`, attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: 200 });
};

export async function scheduleSettlementCatchUp(): Promise<void> {
  await getQueue(QUEUE_NAMES.settlement).upsertJobScheduler('settlement-catch-up', { every: 30_000 }, { name: 'catch-up', data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } });
}

export function startSettlementWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.settlement,
    async (job: Job<{ matchId?: string }>) => {
      if (job.name === 'settle-match' && job.data.matchId) return autoSettleMatch(job.data.matchId);
      if (job.name === 'catch-up') return settlementCatchUp();
      throw new Error(`unknown settlement job ${job.name}`);
    },
    // Per-market locks make parallel runs safe; 2 keeps different matches moving independently.
    { connection: createQueueConnection('worker:settlement'), concurrency: 2 },
  );
  worker.on('failed', (job, err) => logger.error({ job: job?.name, err }, 'settlement job failed'));
  return worker;
}
