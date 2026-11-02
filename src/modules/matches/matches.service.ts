import { Types } from 'mongoose';
import { perOver } from '../../providers/cricket/derive.js';
import type { BallEvent } from '../../providers/cricket/types.js';
import { AppError } from '../../utils/errors.js';
import { Series, Team } from './catalog.models.js';
import { getLiveView } from './matchCache.js';
import { BallEventModel, Match } from './match.model.js';
import { toBallView, toSummary, type BallView, type MatchLiveView, type MatchSummaryView } from './match.views.js';

export type MatchBucket = 'live' | 'upcoming' | 'recent';

const BUCKET_FILTER: Record<MatchBucket, Record<string, unknown>> = {
  live: { status: { $in: ['TOSS', 'LIVE', 'INNINGS_BREAK', 'RAIN_DELAY'] } },
  upcoming: { status: 'UPCOMING' },
  recent: { status: { $in: ['COMPLETED', 'ABANDONED', 'NO_RESULT'] } },
};
const BUCKET_SORT: Record<MatchBucket, Record<string, 1 | -1>> = {
  live: { featured: -1, startTime: 1 },
  upcoming: { startTime: 1 },
  recent: { endedAt: -1, startTime: -1 },
};

export async function listMatches(q: { bucket: MatchBucket; limit: number; source?: 'live' | 'replay'; seriesId?: string; teamKey?: string }): Promise<MatchSummaryView[]> {
  const filter: Record<string, unknown> = { ...BUCKET_FILTER[q.bucket] };
  if (q.source) filter.source = q.source;
  if (q.seriesId) filter.seriesId = new Types.ObjectId(q.seriesId);
  if (q.teamKey) filter['teams.key'] = q.teamKey;
  const rows = await Match.find(filter).sort(BUCKET_SORT[q.bucket]).limit(q.limit).select('-squads -currentState').lean();
  return rows.map(toSummary);
}

export async function getMatch(id: string): Promise<MatchLiveView> {
  const view = await getLiveView(id);
  if (!view) throw AppError.notFound('Match');
  return view;
}

async function loadMatch(id: string) {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Match');
  const m = await Match.findById(id).select('innings teams status format toss result').lean();
  if (!m) throw AppError.notFound('Match');
  return m;
}

export async function getScorecard(id: string) {
  const m = await loadMatch(id);
  return { teams: m.teams, toss: m.toss, result: m.result, innings: m.innings };
}

/** Newest first. `beforeSeq` + `innings` page backwards through the commentary. */
export async function getCommentary(id: string, q: { innings?: number; beforeSeq?: number; limit: number }): Promise<{ items: BallView[]; nextCursor: string | null }> {
  await loadMatch(id);
  const filter: Record<string, unknown> = { matchId: new Types.ObjectId(id) };
  if (q.innings !== undefined) {
    filter.innings = q.innings;
    if (q.beforeSeq !== undefined) filter.seq = { $lt: q.beforeSeq };
  }
  const rows = await BallEventModel.find(filter).sort({ innings: -1, seq: -1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return { items: page.map(toBallView), nextCursor: rows.length > q.limit && last ? `${last.innings}:${last.seq}` : null };
}

/** Per-over runs/wickets per innings: the data behind the run-rate worm and manhattan charts. */
export async function getOvers(id: string) {
  const m = await loadMatch(id);
  const balls = await BallEventModel.find({ matchId: new Types.ObjectId(id) }).sort({ innings: 1, seq: 1 }).lean();
  return m.innings.map((inn) => ({
    innings: inn.number,
    teamKey: inn.battingTeamKey,
    overs: perOver(balls.filter((b) => b.innings === inn.number) as unknown as BallEvent[]),
  }));
}

export async function listSeries(limit: number) {
  const rows = await Series.find({ isShadow: false }).sort({ startDate: -1, lastSyncedAt: -1 }).limit(limit).lean();
  return rows.map((s) => ({ id: s._id.toString(), name: s.name, startDate: s.startDate, endDate: s.endDate, fixtureCounts: s.fixtureCounts, source: s.providerRef.provider }));
}

export async function getSeriesDetail(id: string) {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Series');
  const s = await Series.findById(id).lean();
  if (!s) throw AppError.notFound('Series');
  const matches = await Match.find({ seriesId: s._id }).sort({ startTime: 1 }).select('-squads -currentState').lean();
  return { id: s._id.toString(), name: s.name, startDate: s.startDate, endDate: s.endDate, fixtureCounts: s.fixtureCounts, matches: matches.map(toSummary) };
}

export async function getTeam(key: string) {
  const t = await Team.findOne({ key }).lean();
  if (!t) throw AppError.notFound('Team');
  const recent = await Match.find({ 'teams.key': key, status: 'COMPLETED' }).sort({ endedAt: -1 }).limit(10).select('-squads -currentState').lean();
  return { key: t.key, name: t.name, shortName: t.shortName, logoUrl: t.logoUrl, flagUrl: t.flagUrl, countryCode: t.countryCode, recentMatches: recent.map(toSummary) };
}

export async function searchTeams(q: string, limit: number) {
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const rows = await Team.find({ $or: [{ name: rx }, { shortName: rx }], key: { $ne: 'tbc' } }).sort({ name: 1 }).limit(limit).lean();
  return rows.map((t) => ({ key: t.key, name: t.name, shortName: t.shortName, logoUrl: t.logoUrl, flagUrl: t.flagUrl }));
}
