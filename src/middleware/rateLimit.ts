import type { Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getRedis } from '../config/redis.js';
import { failureBody } from '../utils/http.js';

export interface LimiterOptions {
  /** Redis key namespace, e.g. "login". Must be unique per limiter. */
  name: string;
  windowMs: number;
  limit: number;
  /** Defaults to client IP. Use the user id for per-user limits on authenticated routes. */
  key?: (req: Request) => string;
}

export function createLimiter({ name, windowMs, limit, key }: LimiterOptions): RequestHandler {
  const redis = getRedis();
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(key ? { keyGenerator: key } : {}),
    store: new RedisStore({
      prefix: `rl:${name}:`,
      sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
    }),
    handler: (_req, res) => {
      res.status(429).json(failureBody('RATE_LIMITED', 'Too many requests, slow down'));
    },
  });
}

/** Per-user key for authenticated routes; falls back to IP so it never throws. */
export function userKey(req: Request): string {
  return req.auth?.userId ?? req.ip ?? 'unknown';
}
