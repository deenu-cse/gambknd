import { Worker, type Job } from 'bullmq';
import { logger } from '../config/logger.js';
import { createQueueConnection } from '../config/redis.js';
import { reopenAfterBall, type ReopenScheduler } from '../modules/markets/engine.js';
import { getQueue, QUEUE_NAMES } from './queues.js';

interface ReopenJob {
  matchId: string;
  token: string;
}

/** Delayed "reopen after the bet-safety window" jobs; jobId dedupes repeats for the same delivery. */
export const bullmqReopenScheduler: ReopenScheduler = async (matchId, token, delayMs) => {
  await getQueue(QUEUE_NAMES.markets).add('reopen', { matchId, token } satisfies ReopenJob, {
    delay: delayMs,
    jobId: `reopen-${token}`,
    attempts: 3,
    removeOnComplete: true,
    removeOnFail: 100,
  });
};

export function startMarketsWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.markets,
    async (job: Job<ReopenJob>) => {
      if (job.name !== 'reopen') throw new Error(`unknown markets job ${job.name}`);
      return reopenAfterBall(job.data.matchId, job.data.token);
    },
    { connection: createQueueConnection('worker:markets'), concurrency: 4 },
  );
  worker.on('failed', (job, err) => logger.error({ job: job?.name, err }, 'markets job failed'));
  return worker;
}
