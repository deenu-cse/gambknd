import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import currentMatches from '../fixtures/currentMatches.json' with { type: 'json' };
import fixtures from '../fixtures/matches.json' with { type: 'json' };
import { getRedis } from '../../../config/redis.js';
import { useTestApp } from '../../../tests/helpers.js';
import { ProviderError } from '../adapter.js';
import { CricApiClient } from './cricapi.client.js';
import { HitBudget } from './hitBudget.js';
import { LiveProvider } from './liveProvider.js';
import { CircuitBreaker } from './resilience.js';

useTestApp();

const KEY = 'test-key-0000';

function fakeFetch(handler: (endpoint: string) => { status?: number; body?: unknown }) {
  const calls: URL[] = [];
  const impl = ((input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url);
    const { status = 200, body } = handler(url.pathname.split('/').pop() ?? '');
    return Promise.resolve(new Response(JSON.stringify(body ?? {}), { status }));
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (data: unknown, hitsToday = 1) => ({ apikey: KEY, status: 'success', data, info: { hitsToday, hitsUsed: 1, hitsLimit: 100 } });

function provider(fetchImpl: typeof fetch, breaker = new CircuitBreaker(3, 60_000)) {
  const budget = new HitBudget(getRedis(), 100, 15);
  const client = new CricApiClient({ baseUrl: 'https://api.example.test/v1', apiKey: KEY, timeoutMs: 1000, budget, breaker, fetchImpl });
  return { live: new LiveProvider(client, { ballByBall: true, scorecard: true }), budget, client };
}

describe('LiveProvider over a fake CricAPI', () => {
  it('merges current + fixture lists into normalized matches', async () => {
    const { impl, calls } = fakeFetch((ep) => ({ body: ok(ep === 'currentMatches' ? currentMatches : fixtures, 7) }));
    const { live, budget } = provider(impl);
    const matches = await live.getMatches();
    expect(matches).toHaveLength(currentMatches.length + fixtures.length);
    expect(matches.find((m) => m.providerId === 'b4c6f171-def5-4956-855e-89a9c2edcb9c')?.status).toBe('COMPLETED');
    expect(calls.every((u) => u.searchParams.get('apikey') === KEY)).toBe(true);
    // Budget re-syncs to the provider's own counter.
    expect((await budget.usage()).used).toBe(7);
    expect(JSON.stringify(matches)).not.toContain(KEY);
  });

  it('drops malformed rows instead of failing the page', async () => {
    const { impl } = fakeFetch(() => ({ body: ok([{ nonsense: true }, currentMatches[0]]) }));
    const { live } = provider(impl);
    expect(await live.getMatches()).toHaveLength(1);
  });

  it('maps provider failures to typed errors', async () => {
    const { impl } = fakeFetch(() => ({ body: { apikey: KEY, status: 'failure', reason: 'hits limit reached' } }));
    await expect(provider(impl).live.getLiveScore()).rejects.toMatchObject({ kind: 'BUDGET_EXHAUSTED' });
  });

  it('refuses to spend beyond the daily budget, keeping reserved hits for critical calls', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: ok([]) }));
    const { live } = provider(impl);
    await getRedis().set(`provider:cricapi:hits:${new Date().toISOString().slice(0, 10)}`, '85');
    await expect(live.getLiveScore()).rejects.toMatchObject({ kind: 'BUDGET_EXHAUSTED' });
    expect(calls).toHaveLength(0);
  });

  it('reserves the real ten-hit cost of a scorecard before calling', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: ok([]) }));
    const { client } = provider(impl);
    // 80 used leaves room for a one-hit call (the cap is 85), but not for ten.
    await getRedis().set(`provider:cricapi:hits:${new Date().toISOString().slice(0, 10)}`, '80');
    await expect(client.get('match_scorecard', { id: 'x' }, z.unknown())).rejects.toMatchObject({ kind: 'BUDGET_EXHAUSTED' });
    expect(calls).toHaveLength(0);
  });

  it('retries 5xx, then opens the circuit and fails fast', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 503 }));
    const { live, client } = provider(impl, new CircuitBreaker(2, 60_000));
    await expect(live.getLiveScore()).rejects.toBeInstanceOf(ProviderError);
    expect(calls.length).toBe(3); // 1 try + 2 retries
    await expect(live.getLiveScore()).rejects.toBeInstanceOf(ProviderError);
    expect(client.breakerStatus.state).toBe('OPEN');
    const before = calls.length;
    await expect(live.getLiveScore()).rejects.toMatchObject({ kind: 'CIRCUIT_OPEN' });
    expect(calls.length).toBe(before);
  });
});

describe('CircuitBreaker', () => {
  it('half-opens after the cooldown and closes on success', async () => {
    let t = 0;
    const breaker = new CircuitBreaker(1, 1000, () => t);
    await expect(breaker.exec(() => Promise.reject(new ProviderError('UNAVAILABLE', 'x')))).rejects.toThrow();
    expect(breaker.status.state).toBe('OPEN');
    t = 1500;
    expect(breaker.status.state).toBe('HALF_OPEN');
    await breaker.exec(() => Promise.resolve(1));
    expect(breaker.status.state).toBe('CLOSED');
  });
});
