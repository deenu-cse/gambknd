import { ProviderError } from '../adapter.js';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.retries || !opts.isRetryable(err)) throw err;
      const cap = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
      await sleep(Math.round(Math.random() * cap));
    }
  }
}

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Classic circuit breaker: after `failureThreshold` consecutive failures it opens and fails fast
 * for `cooldownMs`, then lets a single probe through (half-open). A success closes it again.
 */
export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get status(): { state: BreakerState; failures: number; openedAt: number | null } {
    return { state: this.currentState(), failures: this.failures, openedAt: this.openedAt || null };
  }

  private currentState(): BreakerState {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.cooldownMs) this.state = 'HALF_OPEN';
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState();
    if (state === 'OPEN' || (state === 'HALF_OPEN' && this.probeInFlight)) {
      throw new ProviderError('CIRCUIT_OPEN', 'provider circuit is open; failing fast');
    }
    if (state === 'HALF_OPEN') this.probeInFlight = true;
    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'CLOSED';
      return result;
    } catch (err) {
      // Budget exhaustion and 404s are not provider *health* problems.
      const countable = !(err instanceof ProviderError) || err.kind === 'UNAVAILABLE' || err.kind === 'BAD_RESPONSE';
      if (countable) {
        this.failures += 1;
        if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
          this.state = 'OPEN';
          this.openedAt = this.now();
        }
      }
      throw err;
    } finally {
      this.probeInFlight = false;
    }
  }
}
