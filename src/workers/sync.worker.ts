import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createQueueConnection } from '../config/redis.js';
import { pollerTick } from './poller.js';
import { getQueue, QUEUE_NAMES } from './queues.js';

/** The poller heartbeat: a BullMQ job scheduler fires `tick` every POLLER_TICK_MS. */
export async function schedulePoller(): Promise<void> {
  await getQueue(QUEUE_NAMES.sync).upsertJobScheduler(
    'poller-tick',
    { every: env.POLLER_TICK_MS },
    { name: 'tick', data: {}, opts: { removeOnComplete: true, removeOnFail: 100, attempts: 1 } },
  );
}

export function startSyncWorker(): Worker {
  // concurrency 1: ticks never overlap, so replay steps and syncs stay strictly ordered.
  const worker = new Worker(QUEUE_NAMES.sync, () => pollerTick(), { connection: createQueueConnection('worker:sync'), concurrency: 1 });
  worker.on('failed', (job, err) => logger.error({ job: job?.name, err }, 'poller tick failed'));
  return worker;
}
