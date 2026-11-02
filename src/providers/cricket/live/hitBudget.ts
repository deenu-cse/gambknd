import type { Redis } from 'ioredis';
import { ProviderError } from '../adapter.js';

export type HitPriority = 'critical' | 'normal';

// Atomically take `cost` hits if the result stays within `cap`; returns new usage or -1.
const RESERVE_LUA = `
local used = tonumber(redis.call('get', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if used + cost > cap then return -1 end
used = redis.call('incrby', KEYS[1], cost)
redis.call('expire', KEYS[1], 172800)
return used`;

// The provider's own counter is authoritative; only ever move ours upward to match it.
const SYNC_LUA = `
local used = tonumber(redis.call('get', KEYS[1]) or '0')
local reported = tonumber(ARGV[1])
if reported > used then redis.call('set', KEYS[1], reported, 'EX', 172800) return reported end
return used`;

/**
 * Daily API-hit budget shared by every process via Redis. `normal` calls stop at
 * (limit − reserved) so critical calls (results needed for settlement) always have headroom.
 */
export class HitBudget {
  constructor(
    private readonly redis: Redis,
    private limit: number,
    private readonly reserved: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private key(): string {
    return `provider:cricapi:hits:${this.now().toISOString().slice(0, 10)}`;
  }

  async reserve(cost = 1, priority: HitPriority = 'normal'): Promise<number> {
    const cap = priority === 'critical' ? this.limit : Math.max(0, this.limit - this.reserved);
    const used = Number(await this.redis.eval(RESERVE_LUA, 1, this.key(), cost, cap));
    if (used < 0) throw new ProviderError('BUDGET_EXHAUSTED', `daily API budget exhausted (${priority})`);
    return used;
  }

  async sync(hitsToday: number | undefined, hitsLimit: number | undefined): Promise<void> {
    if (typeof hitsLimit === 'number' && hitsLimit > 0) this.limit = hitsLimit;
    if (typeof hitsToday === 'number') await this.redis.eval(SYNC_LUA, 1, this.key(), hitsToday);
  }

  async usage(): Promise<{ used: number; limit: number; reserved: number; remainingNormal: number; resetsAt: Date }> {
    const used = Number((await this.redis.get(this.key())) ?? 0);
    const now = this.now();
    const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return { used, limit: this.limit, reserved: this.reserved, remainingNormal: Math.max(0, this.limit - this.reserved - used), resetsAt };
  }

  /**
   * How often we can afford to poll right now: spread the remaining normal budget evenly over
   * the rest of the UTC day, never faster than `minMs`.
   */
  async recommendedIntervalMs(costPerPoll: number, minMs: number): Promise<number> {
    const { remainingNormal, resetsAt } = await this.usage();
    if (remainingNormal <= 0) return Math.max(minMs, resetsAt.getTime() - this.now().getTime());
    const msLeft = Math.max(1, resetsAt.getTime() - this.now().getTime());
    return Math.max(minMs, Math.ceil((msLeft * costPerPoll) / remainingNormal));
  }
}
