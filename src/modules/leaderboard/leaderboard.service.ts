import { Types } from 'mongoose';
import { getRedis } from '../../config/redis.js';
import { publish } from '../../realtime/bus.js';
import { Bet } from '../bets/bet.model.js';
import { User } from '../users/user.model.js';

export type LeaderboardPeriod = 'daily' | 'weekly' | 'all';
export type LeaderboardMetric = 'profit' | 'roi';

/** ROI ranking needs a real sample, or one lucky 50/1 bet tops the table. */
export const ROI_MIN_BETS = 5;
export const ROI_MIN_STAKED = 100_00;

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function periodKey(period: LeaderboardPeriod, at = new Date()): string {
  if (period === 'daily') return `lb:d:${at.toISOString().slice(0, 10)}`;
  if (period === 'weekly') return `lb:w:${isoWeek(at)}`;
  return 'lb:all';
}

const TTL: Record<LeaderboardPeriod, number | null> = { daily: 8 * 86_400, weekly: 60 * 86_400, all: null };

/**
 * Applies one settled bet to all three boards (sign −1 undoes it, for resettlement).
 * Only bets with a real P&L count: won, lost, cashed out. Voids and rejections don't.
 */
export async function recordSettlement(userId: string, stake: number, payout: number, settledAt: Date, sign: 1 | -1 = 1): Promise<void> {
  const tx = getRedis().multi();
  for (const period of ['daily', 'weekly', 'all'] as const) {
    const key = periodKey(period, settledAt);
    tx.zincrby(`${key}:profit`, sign * (payout - stake), userId).hincrby(`${key}:staked`, userId, sign * stake).hincrby(`${key}:bets`, userId, sign);
    const ttl = TTL[period];
    if (ttl) tx.expire(`${key}:profit`, ttl).expire(`${key}:staked`, ttl).expire(`${key}:bets`, ttl);
  }
  await tx.exec();
  await publish('leaderboard.updated', { period: 'all' });
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  name: string;
  avatar: string | null;
  netProfit: number;
  staked: number;
  bets: number;
  roiBps: number;
}

interface RawRow {
  userId: string;
  netProfit: number;
  staked: number;
  bets: number;
}

async function rows(period: LeaderboardPeriod): Promise<RawRow[]> {
  const key = periodKey(period);
  const redis = getRedis();
  const [profits, staked, bets] = await Promise.all([redis.zrevrange(`${key}:profit`, 0, -1, 'WITHSCORES'), redis.hgetall(`${key}:staked`), redis.hgetall(`${key}:bets`)]);
  const out: RawRow[] = [];
  for (let i = 0; i < profits.length; i += 2) {
    const userId = profits[i] as string;
    const n = Number(bets[userId] ?? 0);
    if (n <= 0) continue;
    out.push({ userId, netProfit: Number(profits[i + 1]), staked: Number(staked[userId] ?? 0), bets: n });
  }
  return out;
}

const roi = (r: RawRow): number => (r.staked > 0 ? Math.round((r.netProfit * 10_000) / r.staked) : 0);

export async function getLeaderboard(period: LeaderboardPeriod, metric: LeaderboardMetric, limit: number, meUserId?: string): Promise<{ rows: LeaderboardRow[]; me: LeaderboardRow | null }> {
  let all = await rows(period);
  if (metric === 'roi') {
    all = all.filter((r) => r.bets >= ROI_MIN_BETS && r.staked >= ROI_MIN_STAKED).sort((a, b) => roi(b) - roi(a) || b.netProfit - a.netProfit);
  } else {
    all.sort((a, b) => b.netProfit - a.netProfit || roi(b) - roi(a));
  }
  const top = all.slice(0, limit);
  const meIdx = meUserId ? all.findIndex((r) => r.userId === meUserId) : -1;
  const ids = [...new Set([...top.map((r) => r.userId), ...(meIdx >= 0 ? [meUserId as string] : [])])].filter((id) => Types.ObjectId.isValid(id));
  const users = new Map((await User.find({ _id: { $in: ids } }).select('name avatar').lean()).map((u) => [u._id.toString(), u]));
  const view = (r: RawRow, rank: number): LeaderboardRow => ({
    rank,
    userId: r.userId,
    name: users.get(r.userId)?.name ?? 'Player',
    avatar: users.get(r.userId)?.avatar ?? null,
    netProfit: r.netProfit,
    staked: r.staked,
    bets: r.bets,
    roiBps: roi(r),
  });
  return { rows: top.map((r, i) => view(r, i + 1)), me: meIdx >= 0 ? view(all[meIdx] as RawRow, meIdx + 1) : null };
}

/** Recomputes every board from the bets collection (admin tool; also after a Redis loss). */
export async function rebuildLeaderboards(): Promise<number> {
  const redis = getRedis();
  for await (const key of redis.scanStream({ match: 'lb:*', count: 500 })) {
    const keys = key as string[];
    if (keys.length > 0) await redis.del(...keys);
  }
  let n = 0;
  for await (const b of Bet.find({ status: { $in: ['WON', 'LOST', 'CASHED_OUT'] } }).select('userId stake payout settledAt').lean().cursor()) {
    if (!b.settledAt) continue;
    await recordSettlement(b.userId.toString(), b.stake, b.payout, b.settledAt);
    n += 1;
  }
  return n;
}
