import type { RequestHandler } from 'express';
import { getRedis } from '../config/redis.js';
import { logger } from '../config/logger.js';

const TTL_SEC = 2 * 3600;
const IGNORED = new Set(['/health', '/ready']);
const minuteOf = (ms: number): number => Math.floor(ms / 60_000);
const key = (kind: 'req' | '5xx', minute: number): string => `metrics:${kind}:${minute}`;

/** Per-minute request and 5xx counters in Redis, so every API process feeds one error rate. */
export const requestMetrics: RequestHandler = (req, res, next) => {
  if (IGNORED.has(req.path)) return next();
  res.on('finish', () => {
    const minute = minuteOf(Date.now());
    const tx = getRedis().multi().incr(key('req', minute)).expire(key('req', minute), TTL_SEC);
    if (res.statusCode >= 500) tx.incr(key('5xx', minute)).expire(key('5xx', minute), TTL_SEC);
    tx.exec().catch((err: unknown) => logger.debug({ err }, 'request metric not recorded'));
  });
  next();
};

export interface ErrorRate {
  windowMinutes: number;
  requests: number;
  errors: number;
  rateBps: number;
}

export async function readErrorRate(windowMinutes = 15): Promise<ErrorRate> {
  const now = minuteOf(Date.now());
  const minutes = Array.from({ length: windowMinutes }, (_, i) => now - i);
  const [reqs, errs] = await Promise.all([getRedis().mget(minutes.map((m) => key('req', m))), getRedis().mget(minutes.map((m) => key('5xx', m)))]);
  const sum = (values: Array<string | null>): number => values.reduce((n, v) => n + Number(v ?? 0), 0);
  const requests = sum(reqs);
  const errors = sum(errs);
  return { windowMinutes, requests, errors, rateBps: requests === 0 ? 0 : Math.round((errors * 10_000) / requests) };
}
