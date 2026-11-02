import type { ZodTypeAny, z } from 'zod';
import { logger } from '../../../config/logger.js';
import { ProviderError } from '../adapter.js';
import type { HitBudget, HitPriority } from './hitBudget.js';
import { CircuitBreaker, withRetry } from './resilience.js';
import { envelopeSchema, type rawInfoSchema } from './schemas.js';

export interface CricApiClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  budget: HitBudget;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
}

export interface CricApiResponse<T> {
  data: T;
  info: z.infer<typeof rawInfoSchema> | undefined;
}

/** Seen in real responses (`info.hitsUsed`): these cost ten hits a call, everything else one. */
const HIT_COST: Record<string, number> = { match_scorecard: 10, match_squad: 10 };

/**
 * Thin, defensive HTTP client for CricAPI v1. The API key travels in the query string and is
 * echoed back in every body, so URLs and bodies are never logged and `apikey` is stripped on receipt.
 */
export class CricApiClient {
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CricApiClientOptions) {
    this.breaker = opts.breaker ?? new CircuitBreaker(5, 30_000);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get breakerStatus(): CircuitBreaker['status'] {
    return this.breaker.status;
  }

  async get<S extends ZodTypeAny>(
    endpoint: string,
    params: Record<string, string | number>,
    dataSchema: S,
    priority: HitPriority = 'normal',
  ): Promise<CricApiResponse<z.infer<S>>> {
    await this.opts.budget.reserve(HIT_COST[endpoint] ?? 1, priority);
    const started = Date.now();
    const body = await this.breaker.exec(() =>
      withRetry(() => this.fetchOnce(endpoint, params), {
        retries: 2,
        baseDelayMs: 300,
        maxDelayMs: 3_000,
        isRetryable: (err) => err instanceof ProviderError && err.retryable,
      }),
    );
    const env = envelopeSchema.safeParse(body);
    if (!env.success) throw new ProviderError('BAD_RESPONSE', `${endpoint}: unexpected envelope`);
    await this.opts.budget.sync(env.data.info?.hitsToday, env.data.info?.hitsLimit);
    if (env.data.status !== 'success') {
      const reason = env.data.reason ?? 'unknown failure';
      // Reason text is the provider's; it never contains our key.
      if (/limit|quota|credits|blocked/i.test(reason)) throw new ProviderError('BUDGET_EXHAUSTED', `${endpoint}: ${reason}`);
      if (/not found|invalid id/i.test(reason)) throw new ProviderError('NOT_FOUND', `${endpoint}: ${reason}`);
      throw new ProviderError('BAD_RESPONSE', `${endpoint}: ${reason}`);
    }
    const data = dataSchema.safeParse(env.data.data);
    if (!data.success) {
      logger.warn({ endpoint, issues: data.error.issues.slice(0, 5) }, 'provider payload failed validation');
      throw new ProviderError('BAD_RESPONSE', `${endpoint}: payload failed validation`);
    }
    logger.debug({ endpoint, ms: Date.now() - started, hitsToday: env.data.info?.hitsToday }, 'provider call ok');
    return { data: data.data as z.infer<S>, info: env.data.info };
  }

  private async fetchOnce(endpoint: string, params: Record<string, string | number>): Promise<unknown> {
    const url = new URL(`${this.opts.baseUrl.replace(/\/$/, '')}/${endpoint}`);
    url.searchParams.set('apikey', this.opts.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (res.status >= 500 || res.status === 429) throw new ProviderError('UNAVAILABLE', `${endpoint}: HTTP ${res.status}`, true);
      if (!res.ok) throw new ProviderError('BAD_RESPONSE', `${endpoint}: HTTP ${res.status}`);
      const json = (await res.json()) as Record<string, unknown>;
      delete json.apikey;
      return json;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new ProviderError('UNAVAILABLE', `${endpoint}: ${aborted ? 'timeout' : 'network error'}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
}
