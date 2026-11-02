import type { AuthContext } from '../../middleware/auth.js';
import { getIo } from '../../realtime/socket.js';
import { Bet, OPEN_BET_STATUSES } from '../bets/bet.model.js';
import { User } from '../users/user.model.js';
import { LedgerEntry } from '../wallet/ledger.model.js';
import { Wallet } from '../wallet/wallet.model.js';
import { totalLiability } from './admin.risk.service.js';

const DAY_MS = 24 * 3600 * 1000;

export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/** Distinct players with a live socket right now: the only signal that's true this instant. */
async function activeUsers(): Promise<number> {
  const io = getIo();
  if (!io) return 0;
  const sockets = await io.of('/user').fetchSockets();
  return new Set(sockets.map((s) => (s.data as { auth?: AuthContext }).auth?.userId)).size;
}

/**
 * House P&L per UTC day, from the `house` ledger account: credits are captured stakes, debits are
 * payouts and cash-outs. Bonuses and admin credits never touch it, so they don't count as losses.
 */
async function housePnlByDay(since: Date): Promise<Map<string, number>> {
  const rows = await LedgerEntry.aggregate<{ _id: string; net: number }>([
    { $match: { account: 'house', createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
        net: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', { $multiply: ['$amount', -1] }] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [r._id, r.net]));
}

function sumSince(pnl: Map<string, number>, from: Date): number {
  const start = dayKey(from);
  let total = 0;
  for (const [day, net] of pnl) if (day >= start) total += net;
  return total;
}

export async function getOverview(now = new Date()) {
  const today = utcDayStart(now);
  const d7 = new Date(today.getTime() - 6 * DAY_MS);
  const d30 = new Date(today.getTime() - 29 * DAY_MS);
  const [totalUsers, newToday, suspended, activeNow, circulation, staked, openBets, liability, pnl] = await Promise.all([
    User.countDocuments({ role: 'user' }),
    User.countDocuments({ role: 'user', createdAt: { $gte: today } }),
    User.countDocuments({ status: 'suspended' }),
    activeUsers(),
    Wallet.aggregate<{ balance: number; locked: number }>([{ $group: { _id: null, balance: { $sum: '$balance' }, locked: { $sum: '$lockedBalance' } } }]),
    Bet.aggregate<{ stake: number; bets: number }>([
      { $match: { placedAt: { $gte: today }, status: { $ne: 'REJECTED' } } },
      { $group: { _id: null, stake: { $sum: '$stake' }, bets: { $sum: 1 } } },
    ]),
    Bet.countDocuments({ status: { $in: OPEN_BET_STATUSES } }),
    totalLiability(),
    housePnlByDay(d30),
  ]);
  return {
    users: { total: totalUsers, newToday, suspended, activeNow },
    tokens: { circulation: circulation[0]?.balance ?? 0, locked: circulation[0]?.locked ?? 0 },
    today: { staked: staked[0]?.stake ?? 0, bets: staked[0]?.bets ?? 0 },
    openBets,
    totalLiability: liability,
    housePnl: { today: sumSince(pnl, today), d7: sumSince(pnl, d7), d30: sumSince(pnl, d30) },
    generatedAt: now,
  };
}

export async function getCharts(days: number, now = new Date()) {
  const since = new Date(utcDayStart(now).getTime() - (days - 1) * DAY_MS);
  const [daily, byType] = await Promise.all([
    Bet.aggregate<{ _id: string; bets: number; staked: number }>([
      { $match: { placedAt: { $gte: since }, status: { $ne: 'REJECTED' } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$placedAt', timezone: 'UTC' } }, bets: { $sum: 1 }, staked: { $sum: '$stake' } } },
    ]),
    Bet.aggregate<{ _id: string; pnl: number; staked: number; bets: number }>([
      { $match: { settledAt: { $gte: since }, status: { $in: ['WON', 'LOST', 'CASHED_OUT'] } } },
      { $project: { stake: 1, payout: 1, type: { $cond: [{ $eq: ['$kind', 'ACCA'] }, 'ACCUMULATOR', { $arrayElemAt: ['$legs.marketType', 0] }] } } },
      { $group: { _id: '$type', pnl: { $sum: { $subtract: ['$stake', '$payout'] } }, staked: { $sum: '$stake' }, bets: { $sum: 1 } } },
      { $sort: { pnl: -1 } },
    ]),
  ]);
  const byDay = new Map(daily.map((d) => [d._id, d]));
  return {
    days,
    // Every day is present, so a quiet day shows as a gap in the chart rather than vanishing.
    betsOverTime: Array.from({ length: days }, (_, i) => {
      const date = dayKey(new Date(since.getTime() + i * DAY_MS));
      const d = byDay.get(date);
      return { date, bets: d?.bets ?? 0, staked: d?.staked ?? 0 };
    }),
    pnlByMarketType: byType.map((t) => ({ marketType: t._id, pnl: t.pnl, staked: t.staked, bets: t.bets })),
  };
}
