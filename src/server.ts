import { createServer } from 'node:http';
import { createApp } from './app.js';
import { connectMongo, disconnectMongo } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeRedis, getRedis } from './config/redis.js';
import { attachSocketServer } from './realtime/socket.js';
import { setReopenScheduler } from './modules/markets/engine.js';
import { bullmqReopenScheduler } from './workers/markets.worker.js';
import { bullmqAcceptanceScheduler } from './workers/bets.worker.js';
import { setAcceptanceScheduler } from './modules/bets/placement.service.js';

async function main(): Promise<void> {
  await connectMongo(env.MONGO_URI);
  await getRedis().ping();
  setReopenScheduler(bullmqReopenScheduler);
  // In-play bets placed through the API get their delayed acceptance job queued here.
  setAcceptanceScheduler(bullmqAcceptanceScheduler);

  const app = createApp();
  const server = createServer(app);
  server.keepAliveTimeout = 65_000;
  const sockets = await attachSocketServer(server);

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new Error(`Port ${env.PORT} is already in use. Stop that process or set PORT.`) : err),
    );
    server.listen(env.PORT, resolve);
  });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'gambknd listening');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    void sockets.close().finally(() =>
      server.close(() => {
        void Promise.allSettled([disconnectMongo(), closeRedis()]).then(() => process.exit(0));
      }),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
