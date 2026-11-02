import { Types } from 'mongoose';
import { FINISHED_STATUSES, IN_PROGRESS_STATUSES } from '../../providers/cricket/types.js';
import { AppError } from '../../utils/errors.js';
import { Bet, OPEN_BET_STATUSES } from '../bets/bet.model.js';
import { Market } from '../markets/market.model.js';
import { Match } from '../matches/match.model.js';
import { toLiveView, toSummary } from '../matches/match.views.js';
import type { AdminMatchesQuery } from './admin.schema.js';

const BUCKETS: Record<Exclude<AdminMatchesQuery['bucket'], 'all'>, readonly string[]> = {
  live: IN_PROGRESS_STATUSES,
  upcoming: ['UPCOMING'],
  recent: FINISHED_STATUSES,
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function bookCounts(ids: Types.ObjectId[]) {
  const [markets, bets] = await Promise.all([
    Market.aggregate<{ _id: { matchId: Types.ObjectId; status: string }; count: number }>([
      { $match: { matchId: { $in: ids } } },
      { $group: { _id: { matchId: '$matchId', status: '$status' }, count: { $sum: 1 } } },
    ]),
    Bet.aggregate<{ _id: Types.ObjectId; openBets: number; openStake: number }>([
      { $match: { status: { $in: OPEN_BET_STATUSES }, 'legs.matchId': { $in: ids } } },
      { $unwind: '$legs' },
      { $match: { 'legs.matchId': { $in: ids } } },
      { $group: { _id: '$legs.matchId', openBets: { $sum: 1 }, openStake: { $sum: '$stake' } } },
    ]),
  ]);
  return (id: Types.ObjectId) => {
    const key = id.toString();
    const rows = markets.filter((m) => m._id.matchId.toString() === key);
    const of = (status: string): number => rows.find((r) => r._id.status === status)?.count ?? 0;
    const bet = bets.find((b) => b._id.toString() === key);
    return {
      markets: { total: rows.reduce((n, r) => n + r.count, 0), open: of('OPEN'), suspended: of('SUSPENDED') },
      openBets: bet?.openBets ?? 0,
      openStake: bet?.openStake ?? 0,
    };
  };
}

export async function adminListMatches(q: AdminMatchesQuery) {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  else if (q.bucket !== 'all') filter.status = { $in: BUCKETS[q.bucket] };
  if (q.source) filter.source = q.source;
  if (q.q) filter.title = { $regex: escapeRegex(q.q), $options: 'i' };
  if (q.cursor) filter._id = { $lt: new Types.ObjectId(q.cursor) };
  const rows = await Match.find(filter).sort({ _id: -1 }).limit(q.limit + 1).select('-squads -currentState').lean();
  const page = rows.slice(0, q.limit);
  const counts = await bookCounts(page.map((m) => m._id));
  return {
    items: page.map((m) => ({ ...toSummary(m), ...counts(m._id) })),
    nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null,
  };
}

export async function adminGetMatch(id: string) {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Match');
  const match = await Match.findById(id).select('-squads').lean();
  if (!match) throw AppError.notFound('Match');
  const counts = await bookCounts([match._id]);
  return { ...toLiveView(match), providerId: match.providerRef.id, ...counts(match._id) };
}
