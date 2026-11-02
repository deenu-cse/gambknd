import { Worker, type Job } from 'bullmq';
import { logger } from '../config/logger.js';
import { createQueueConnection } from '../config/redis.js';
import { acceptPendingBet, sweepPendingBets, type AcceptanceScheduler } from '../modules/bets/placement.service.js';
import { getQueue, QUEUE_NAMES } from './queues.js';

/** In-play bets: a delayed job re-checks the market when the bet delay ends. */
export const bullmqAcceptanceScheduler: AcceptanceScheduler = async (betId, delayMs) => {
  await getQueue(QUEUE_NAMES.bets).add('accept', { betId }, { delay: delayMs, jobId: `accept-${betId}`, attempts: 5, backoff: { type: 'exponential', delay: 500 }, removeOnComplete: true, removeOnFail: 500 });
};

/** Backstop for lost jobs (e.g. Redis restart): sweep overdue delayed bets every 10s. */
export async function scheduleBetSweeper(): Promise<void> {
  await getQueue(QUEUE_NAMES.bets).upsertJobScheduler('sweep-pending', { every: 10_000 }, { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } });
}

export function startBetsWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.bets,
    async (job: Job<{ betId?: string }>) => {
      if (job.name === 'accept' && job.data.betId) return (await acceptPendingBet(job.data.betId))?.status ?? 'noop';
      if (job.name === 'sweep') return sweepPendingBets();
      throw new Error(`unknown bets job ${job.name}`);
    },
    { connection: createQueueConnection('worker:bets'), concurrency: 8 },
  );
  worker.on('failed', (job, err) => logger.error({ job: job?.name, err }, 'bets job failed'));
  return worker;
}
