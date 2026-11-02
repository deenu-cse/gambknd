import { randomUUID } from 'node:crypto';
import { getRedis } from '../config/redis.js';

// Delete only if we still own the lock (it may have expired and been taken by someone else).
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  const ok = await getRedis().set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
  return ok === 'OK' ? token : null;
}

export async function releaseLock(key: string, token: string): Promise<void> {
  await getRedis().eval(RELEASE_LUA, 1, `lock:${key}`, token);
}

/** Runs `fn` while holding a Redis lock; returns `onBusy()` if someone else holds it. */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>, onBusy: () => T | Promise<T>): Promise<T> {
  const token = await acquireLock(key, ttlMs);
  if (!token) return onBusy();
  try {
    return await fn();
  } finally {
    await releaseLock(key, token);
  }
}
