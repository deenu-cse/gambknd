import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { getRedis } from './config/redis.js';
import { requireJsonForMutations } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createLimiter } from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import { requestMetrics } from './middleware/requestMetrics.js';
import { sanitizeInput } from './middleware/sanitize.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createUsersRouter } from './modules/users/users.routes.js';
import { createWalletRouter } from './modules/wallet/wallet.routes.js';
import { createAdminRouter } from './modules/admin/admin.routes.js';
import { createMatchesRouter } from './modules/matches/matches.routes.js';
import { createBetsRouter } from './modules/bets/bets.routes.js';
import { createNotificationsRouter } from './modules/notifications/notifications.routes.js';
import { createLeaderboardRouter } from './modules/leaderboard/leaderboard.routes.js';
import { createCompareRouter } from './modules/compare/compare.routes.js';
import { sendOk } from './utils/http.js';
import { getSettings } from './modules/settings/settings.service.js';
import { AppError } from './utils/errors.js';

function trustProxySetting(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxySetting(env.TRUST_PROXY));

  app.use(requestId);
  app.use(requestMetrics);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => req.url === '/health' },
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({ method: req.method, url: req.url, id: req.id }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // No Origin header = same-origin or non-browser client (curl, server-to-server).
        if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        cb(new AppError('FORBIDDEN', 'Origin not allowed'));
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-Request-Id', 'Idempotency-Key', 'Authorization'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(sanitizeInput);

  app.get('/health', (_req, res) => sendOk(res, { status: 'ok', uptimeSec: Math.round(process.uptime()) }));
  app.get('/ready', async (_req, res) => {
    const mongoOk = mongoose.connection.readyState === mongoose.ConnectionStates.connected;
    const redisOk = (await getRedis().ping().catch(() => null)) === 'PONG';
    if (!mongoOk || !redisOk) throw new AppError('SERVICE_UNAVAILABLE', 'Dependencies not ready', { mongoOk, redisOk });
    sendOk(res, { mongo: 'ok', redis: 'ok' });
  });

  const api = express.Router();
  // Public platform status for the frontends' maintenance banner.
  api.get('/status', async (_req, res) => {
    const settings = await getSettings();
    sendOk(res, { maintenance: settings.maintenance, providerMode: settings.providerMode, unitsPerToken: 100, serverTime: new Date() });
  });
  api.use(createLimiter({ name: 'global', windowMs: 60_000, limit: 600 }));
  api.use(requireJsonForMutations);
  api.use('/auth', createAuthRouter('user'));
  api.use('/admin/auth', createAuthRouter('admin'));
  api.use('/users', createUsersRouter());
  api.use('/wallet', createWalletRouter());
  api.use('/bets', createBetsRouter());
  api.use('/notifications', createNotificationsRouter());
  api.use('/leaderboard', createLeaderboardRouter());
  api.use('/compare', createCompareRouter());
  api.use('/admin', createAdminRouter());
  api.use('/', createMatchesRouter());
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
