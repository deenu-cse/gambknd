import { env } from '../../config/env.js';
import { getRedis } from '../../config/redis.js';
import { sha256 } from '../../utils/crypto.js';
import type { Realm } from './session.model.js';

// Keys use a hash of the email so raw addresses don't sit in Redis.
const failKey = (realm: Realm, email: string): string => `auth:fail:${realm}:${sha256(email)}`;
const lockKey = (realm: Realm, email: string): string => `auth:lock:${realm}:${sha256(email)}`;

/** Seconds left on the lock, or 0 if the account isn't locked. */
export async function lockRemainingSec(realm: Realm, email: string): Promise<number> {
  const ttl = await getRedis().ttl(lockKey(realm, email));
  return ttl > 0 ? ttl : 0;
}

/** Records a failed login. Returns true if this failure triggered a lock. */
export async function recordLoginFailure(realm: Realm, email: string): Promise<boolean> {
  const redis = getRedis();
  const lockSec = env.LOGIN_LOCK_MINUTES * 60;
  const key = failKey(realm, email);
  const [[, count]] = (await redis.multi().incr(key).expire(key, lockSec, 'NX').exec()) as [[Error | null, number]];
  if (count >= env.LOGIN_MAX_FAILURES) {
    await redis.multi().set(lockKey(realm, email), '1', 'EX', lockSec).del(key).exec();
    return true;
  }
  return false;
}

export async function clearLoginFailures(realm: Realm, email: string): Promise<void> {
  await getRedis().del(failKey(realm, email));
}

export async function clearLock(realm: Realm, email: string): Promise<void> {
  await getRedis().del(lockKey(realm, email), failKey(realm, email));
}
