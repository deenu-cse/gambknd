import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

const clients = new Set<Redis>();

function build(name: string, overrides: RedisOptions = {}): Redis {
  const client = new Redis(env.REDIS_URL, {
    connectionName: `gambknd:${name}`,
    lazyConnect: false,
    enableAutoPipelining: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    ...overrides,
  });
  client.on('error', (err) => logger.error({ err, client: name }, 'redis error'));
  clients.add(client);
  return client;
}

let shared: Redis | undefined;

/** Shared command connection for cache, locks, counters and rate limits. */
export function getRedis(): Redis {
  shared ??= build('main');
  return shared;
}

/** Dedicated connection, e.g. for pub/sub subscribers, which can't run other commands. */
export function createRedisConnection(name: string): Redis {
  return build(name);
}

/** BullMQ needs `maxRetriesPerRequest: null` on its connections. */
export function createQueueConnection(name: string): Redis {
  return build(name, { maxRetriesPerRequest: null, enableAutoPipelining: false });
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([...clients].map((c) => c.quit()));
  clients.clear();
  shared = undefined;
}
