import type { Types } from 'mongoose';
import { Bet, OPEN_BET_STATUSES, type IBet } from '../bets/bet.model.js';
import { toAdminBetView } from '../bets/bet.views.js';
import { getBooks } from '../markets/liability.js';
import { Market } from '../markets/market.model.js';
import { Match } from '../matches/match.model.js';
import { User } from '../users/user.model.js';

const LIVE_BOOK_STATUSES = ['PENDING', 'OPEN', 'SUSPENDED', 'CLOSED'];
const MIN_Z_SCORE = 2;
const DAY_MS = 24 * 3600 * 1000;

export interface ExposureRow {
  marketId: string;
  matchId: string;
  matchTitle: string;
  marketName: string;
  marketType: string;
  status: string;
  totalStake: number;
  bets: number;
  maxLiability: number;
  /** Largest house loss across selections; negative means the house wins whatever happens. */
  worstCaseLoss: number;
  utilizationBps: number;
  selections: Array<{ id: string; name: string; odds: number; worstCaseLoss: number }>;
}

/** Only markets with open bets carry risk, so the Redis read stays proportional to live exposure. */
export async function marketExposure(): Promise<ExposureRow[]> {
  const ids = await Bet.distinct('legs.marketId', { status: { $in: OPEN_BET_STATUSES } });
  if (ids.length === 0) return [];
  const markets = await Market.find({ _id: { $in: ids }, status: { $in: LIVE_BOOK_STATUSES } }).select('matchId name type status maxLiability selections').lean();
  const [books, matches] = await Promise.all([
    getBooks(markets.map((m) => ({ id: m._id.toString(), selectionIds: m.selections.map((s) => s.id) }))),
    Match.find({ _id: { $in: markets.map((m) => m.matchId) } }).select('title').lean(),
  ]);
  const titles = new Map(matches.map((m) => [m._id.toString(), m.title]));
  const rows = markets.map((m): ExposureRow => {
    const id = m._id.toString();
    const book = books.get(id);
    const selections = m.selections.map((s) => ({ id: s.id, name: s.name, odds: s.odds, worstCaseLoss: book?.worstCaseLoss[s.id] ?? 0 }));
    const worst = selections.length ? Math.max(...selections.map((s) => s.worstCaseLoss)) : 0;
    return {
      marketId: id, matchId: m.matchId.toString(), matchTitle: titles.get(m.matchId.toString()) ?? 'Unknown match', marketName: m.name, marketType: m.type,
      status: m.status, totalStake: book?.totalStake ?? 0, bets: book?.bets ?? 0, maxLiability: m.maxLiability, worstCaseLoss: worst,
      utilizationBps: Math.round((Math.max(0, worst) * 10_000) / m.maxLiability), selections,
    };
  });
  return rows.sort((a, b) => b.worstCaseLoss - a.worstCaseLoss);
}

/** Markets settle independently, so the sum of their positive worst cases is the true ceiling. */
export async function totalLiability(): Promise<number> {
  return (await marketExposure()).reduce((sum, m) => sum + Math.max(0, m.worstCaseLoss), 0);
}

async function userNames(ids: Types.ObjectId[]): Promise<Map<string, { name: string; email: string }>> {
  const users = await User.find({ _id: { $in: ids } }).select('name email').lean();
  return new Map(users.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));
}

async function biggestBets() {
  const bets: IBet[] = await Bet.find({ status: { $in: OPEN_BET_STATUSES } }).sort({ potentialReturn: -1 }).limit(20).lean();
  const users = await userNames(bets.map((b) => b.userId));
  return bets.map((b) => ({ ...toAdminBetView(b), user: users.get(b.userId.toString()) ?? null }));
}

/**
 * Flags players beating the prices, not just players who win a lot: a bettor backing 1.10 favourites
 * wins most of the time and that's normal. Each bet's implied probability gives expected wins and a
 * binomial variance; z = (actual − expected) / σ. Probabilities here are statistics, never money.
 */
async function unusualWinRates(minBets: number, days: number) {
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await Bet.aggregate<{ _id: Types.ObjectId; bets: number; wins: number; expected: number; variance: number; staked: number; returned: number }>([
    { $match: { settledAt: { $gte: since }, status: { $in: ['WON', 'LOST'] } } },
    { $project: { userId: 1, stake: 1, payout: 1, won: { $cond: [{ $eq: ['$status', 'WON'] }, 1, 0] }, p: { $divide: [100, '$odds'] } } },
    {
      $group: {
        _id: '$userId', bets: { $sum: 1 }, wins: { $sum: '$won' }, expected: { $sum: '$p' },
        variance: { $sum: { $multiply: ['$p', { $subtract: [1, '$p'] }] } }, staked: { $sum: '$stake' }, returned: { $sum: '$payout' },
      },
    },
    { $match: { bets: { $gte: minBets } } },
  ]);
  const scored = rows
    .map((r) => ({ ...r, z: r.variance > 0 ? (r.wins - r.expected) / Math.sqrt(r.variance) : 0 }))
    .filter((r) => r.z >= MIN_Z_SCORE)
    .sort((a, b) => b.z - a.z)
    .slice(0, 20);
  const users = await userNames(scored.map((r) => r._id));
  return scored.map((r) => ({
    userId: r._id.toString(), user: users.get(r._id.toString()) ?? null, bets: r.bets, wins: r.wins,
    winRateBps: Math.round((r.wins * 10_000) / r.bets), expectedWinRateBps: Math.round((r.expected * 10_000) / r.bets),
    zScoreX100: Math.round(r.z * 100), staked: r.staked, returned: r.returned, netWin: r.returned - r.staked,
  }));
}

export async function getRisk(q: { minBets: number; days: number }) {
  const [markets, biggest, unusual] = await Promise.all([marketExposure(), biggestBets(), unusualWinRates(q.minBets, q.days)]);
  return {
    totalLiability: markets.reduce((sum, m) => sum + Math.max(0, m.worstCaseLoss), 0),
    markets: markets.slice(0, 100),
    biggestBets: biggest,
    unusualWinRates: unusual,
    window: { days: q.days, minBets: q.minBets, minZScore: MIN_Z_SCORE },
    generatedAt: new Date(),
  };
}
