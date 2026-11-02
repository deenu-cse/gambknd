import type { Worker } from 'bullmq';
import { connectMongo, disconnectMongo } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { closeRedis } from '../config/redis.js';
import { scheduleMaintenance, startMaintenanceWorker } from './maintenance.worker.js';
import { closeQueues } from './queues.js';
import { schedulePoller, startSyncWorker } from './sync.worker.js';
import { bullmqReopenScheduler, startMarketsWorker } from './markets.worker.js';
import { onMatchChange, setReopenScheduler } from '../modules/markets/engine.js';
import { registerMatchChangeHandler } from '../modules/matches/matchEvents.js';
import { bullmqAcceptanceScheduler, scheduleBetSweeper, startBetsWorker } from './bets.worker.js';
import { setAcceptanceScheduler } from '../modules/bets/placement.service.js';
import { bullmqSettlementScheduler, scheduleSettlementCatchUp, startSettlementWorker } from './settlement.worker.js';
import { onMatchChangeSettle, setSettlementScheduler } from '../modules/settlement/settlement.handler.js';

/** Background process: `npm run worker`. Runs separately from the API so jobs survive API restarts. */
async function main(): Promise<void> {
  await connectMongo(env.MONGO_URI);
  setReopenScheduler(bullmqReopenScheduler);
  setAcceptanceScheduler(bullmqAcceptanceScheduler);
  // The market engine reacts to every synced change: create, price, suspend, close.
  registerMatchChangeHandler('markets', onMatchChange);
  // Settlement runs after the engine has closed whatever this change decided.
  setSettlementScheduler(bullmqSettlementScheduler);
  registerMatchChangeHandler('settlement', onMatchChangeSettle);
  const workers: Worker[] = [startMaintenanceWorker(), startSyncWorker(), startMarketsWorker(), startBetsWorker(), startSettlementWorker()];
  await scheduleMaintenance();
  await schedulePoller();
  await scheduleBetSweeper();
  await scheduleSettlementCatchUp();
  logger.info({ workers: workers.map((w) => w.name) }, 'workers started');

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'stopping workers');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    void Promise.allSettled(workers.map((w) => w.close()))
      .then(() => Promise.allSettled([closeQueues(), disconnectMongo(), closeRedis()]))
      .then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
