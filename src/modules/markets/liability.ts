import { getRedis } from '../../config/redis.js';

/**
 * Per-market book in Redis: total stakes, and total potential returns per selection.
 * Worst-case house loss if selection S wins = returns(S) − stakes (stakes are kept, returns paid).
 * Updated atomically on every accepted bet / refund (Phase 5); read by the pricer for shading.
 */
const key = (marketId: string): string => `liab:${marketId}`;

export async function addExposure(marketId: string, selectionId: string, stake: number, potentialReturn: number, sign: 1 | -1 = 1): Promise<void> {
  await getRedis()
    .multi()
    .hincrby(key(marketId), 'stake', sign * stake)
    .hincrby(key(marketId), `ret:${selectionId}`, sign * potentialReturn)
    .hincrby(key(marketId), 'bets', sign)
    .expire(key(marketId), 14 * 24 * 3600)
    .exec();
}

export interface MarketBook {
  totalStake: number;
  bets: number;
  worstCaseLoss: Record<string, number>;
}

export async function getBook(marketId: string, selectionIds: readonly string[]): Promise<MarketBook> {
  const raw = await getRedis().hgetall(key(marketId));
  const totalStake = Number(raw.stake ?? 0);
  return {
    totalStake,
    bets: Number(raw.bets ?? 0),
    worstCaseLoss: Object.fromEntries(selectionIds.map((id) => [id, Number(raw[`ret:${id}`] ?? 0) - totalStake])),
  };
}

export async function getBooks(markets: ReadonlyArray<{ id: string; selectionIds: readonly string[] }>): Promise<Map<string, MarketBook>> {
  const out = new Map<string, MarketBook>();
  await Promise.all(markets.map(async (m) => out.set(m.id, await getBook(m.id, m.selectionIds))));
  return out;
}

/** Rebuild from the bets collection (admin tool / after Redis loss). */
export async function resetBook(marketId: string, entries: ReadonlyArray<{ selectionId: string; stake: number; potentialReturn: number }>): Promise<void> {
  const tx = getRedis().multi().del(key(marketId));
  for (const e of entries) {
    tx.hincrby(key(marketId), 'stake', e.stake).hincrby(key(marketId), `ret:${e.selectionId}`, e.potentialReturn).hincrby(key(marketId), 'bets', 1);
  }
  await tx.expire(key(marketId), 14 * 24 * 3600).exec();
}
