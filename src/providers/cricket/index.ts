import { env } from '../../config/env.js';
import { getRedis } from '../../config/redis.js';
import type { CricketProvider } from './adapter.js';
import { CricApiClient } from './live/cricapi.client.js';
import { HitBudget } from './live/hitBudget.js';
import { LiveProvider } from './live/liveProvider.js';
import { ReplayProvider } from './replay/replayProvider.js';
import { ReplaySessionStore } from './replay/sessions.js';

export type { CricketProvider } from './adapter.js';
export { ProviderError } from './adapter.js';

let budget: HitBudget | undefined;
let client: CricApiClient | undefined;
let live: LiveProvider | undefined;
let replay: ReplayProvider | undefined;
let store: ReplaySessionStore | undefined;

export function getHitBudget(): HitBudget {
  budget ??= new HitBudget(getRedis(), env.CRICAPI_DAILY_HIT_LIMIT, env.CRICAPI_RESERVED_HITS);
  return budget;
}

export function getReplayStore(): ReplaySessionStore {
  store ??= new ReplaySessionStore(getRedis());
  return store;
}

export function getReplayProvider(): ReplayProvider {
  replay ??= new ReplayProvider(getReplayStore());
  return replay;
}

/** null when no CRICAPI_KEY is configured: live polling is then simply off. */
export function getLiveProvider(): LiveProvider | null {
  if (!env.CRICAPI_KEY) return null;
  client ??= new CricApiClient({ baseUrl: env.CRICAPI_BASE_URL, apiKey: env.CRICAPI_KEY, timeoutMs: env.CRICAPI_TIMEOUT_MS, budget: getHitBudget() });
  live ??= new LiveProvider(client, { ballByBall: env.CRICAPI_BBB_ENABLED, scorecard: env.CRICAPI_SCORECARD_ENABLED });
  return live;
}

export function getLiveClientStatus(): CricApiClient['breakerStatus'] | null {
  return client?.breakerStatus ?? null;
}

/** Provider that owns a stored match, by its source. */
export function providerFor(source: 'live' | 'replay'): CricketProvider | null {
  return source === 'replay' ? getReplayProvider() : getLiveProvider();
}
