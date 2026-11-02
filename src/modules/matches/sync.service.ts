import { type Types } from 'mongoose';
import { deriveInnings } from '../../providers/cricket/derive.js';
import { FINISHED_STATUSES, type BallEvent, type Innings, type ProviderMatch, type TeamRef } from '../../providers/cricket/types.js';
import { publish } from '../../realtime/bus.js';
import { Series, Team } from './catalog.models.js';
import { computeCurrentState } from './liveState.js';
import { cacheLiveView } from './matchCache.js';
import { dispatchMatchChange, type MatchChange } from './matchEvents.js';
import { BallEventModel, Match, type IBallEvent, type IMatch } from './match.model.js';
import { toBallView, toLiveView } from './match.views.js';

const MAX_BALL_EVENTS_PER_SYNC = 12;

export async function upsertTeams(teams: readonly TeamRef[]): Promise<void> {
  await Team.bulkWrite(
    teams.map((t) => ({
      updateOne: {
        filter: { key: t.key },
        update: {
          $setOnInsert: { key: t.key, name: t.name, aliases: [] },
          $set: { shortName: t.shortName, ...(t.logoUrl ? { logoUrl: t.logoUrl } : {}) },
        },
        upsert: true,
      },
    })),
  );
}

async function resolveSeriesId(pm: ProviderMatch): Promise<Types.ObjectId | null> {
  if (!pm.seriesProviderId) return null;
  const series = await Series.findOneAndUpdate(
    { 'providerRef.provider': pm.source, 'providerRef.id': pm.seriesProviderId },
    {
      $setOnInsert: {
        name: pm.seriesName ?? 'Series',
        startDate: null,
        endDate: null,
        fixtureCounts: { odi: 0, t20: 0, test: 0, total: 0 },
        squadsAnnounced: 0,
        isShadow: false,
      },
      $set: { lastSyncedAt: new Date() },
    },
    { upsert: true, new: true, lean: true },
  );
  return series?._id ?? null;
}

/** Score-only feeds have no batting/bowling lines; fill them from ball-by-ball when we have it. */
function composeInnings(pm: ProviderMatch, scorecard: Innings[] | undefined, balls: readonly BallEvent[]): Innings[] {
  const base = scorecard && scorecard.length >= pm.innings.length ? scorecard : pm.innings;
  if (balls.length === 0) return base;
  return base.map((inn) => {
    if (inn.batting.length > 0) return inn;
    const own = balls.filter((b) => b.innings === inn.number);
    if (own.length === 0) return inn;
    const d = deriveInnings(own);
    return { ...inn, extras: d.extras, batting: d.batting, bowling: d.bowling, fallOfWickets: d.fallOfWickets };
  });
}

function fingerprint(m: Pick<IMatch, 'status' | 'statusText' | 'innings' | 'toss' | 'result'>): string {
  return JSON.stringify([m.status, m.statusText, m.innings.map((i) => [i.runs, i.wickets, i.balls, i.isComplete]), m.toss, m.result]);
}

async function insertNewBalls(matchId: Types.ObjectId, balls: readonly BallEvent[]): Promise<IBallEvent[]> {
  if (balls.length === 0) return [];
  const maxSeq = await BallEventModel.aggregate<{ _id: number; seq: number }>([
    { $match: { matchId } },
    { $group: { _id: '$innings', seq: { $max: '$seq' } } },
  ]);
  const seen = new Map(maxSeq.map((r) => [r._id, r.seq]));
  const fresh = balls.filter((b) => b.seq > (seen.get(b.innings) ?? 0));
  if (fresh.length === 0) return [];
  try {
    const docs = await BallEventModel.insertMany(
      fresh.map((b) => ({ ...b, matchId })),
      { ordered: false },
    );
    return docs.map((d) => d.toObject());
  } catch (err) {
    // A concurrent sync inserted some of the same balls; the unique index kept them single. Re-read.
    if ((err as { code?: number }).code !== 11000) throw err;
    return BallEventModel.find({ matchId, $or: fresh.map((b) => ({ innings: b.innings, seq: b.seq })) }).lean();
  }
}

/**
 * Applies one provider snapshot. Idempotent: syncing the same snapshot twice changes nothing
 * except lastSyncedAt. Emits realtime events and match-change handlers only for real changes.
 */
export async function syncMatch(pm: ProviderMatch, opts: { balls?: BallEvent[]; scorecard?: Innings[] } = {}): Promise<MatchChange | null> {
  const balls = opts.balls ?? [];
  await upsertTeams(pm.teams);
  const existing = await Match.findOne({ 'providerRef.provider': pm.source, 'providerRef.id': pm.providerId });
  const now = new Date();
  const innings = composeInnings(pm, opts.scorecard, balls);
  const finished = FINISHED_STATUSES.includes(pm.status);

  const next = {
    title: pm.title,
    matchLabel: pm.matchLabel,
    seriesName: pm.seriesName,
    format: pm.format,
    scheduledOvers: pm.scheduledOvers,
    teams: pm.teams,
    venue: pm.venue,
    startTime: pm.startTime,
    startTimeConfirmed: pm.startTimeConfirmed,
    status: pm.status,
    statusText: pm.statusText,
    toss: pm.toss ?? existing?.toss ?? null,
    innings,
    result: pm.result,
    capabilities: pm.capabilities,
  };
  const before = existing ? fingerprint(existing) : null;
  const changed = before !== fingerprint(next);

  const doc = existing ?? new Match({ providerRef: { provider: pm.source, id: pm.providerId }, source: pm.source, bettingEnabled: !pm.teams.some((t) => t.key === 'tbc') });
  const statusFrom = existing?.status ?? null;
  const tossChanged = JSON.stringify(existing?.toss ?? null) !== JSON.stringify(next.toss);
  const resultChanged = JSON.stringify(existing?.result ?? null) !== JSON.stringify(next.result);
  const completedBefore = new Set((existing?.innings ?? []).filter((i) => i.isComplete).map((i) => i.number));
  const wasStale = existing?.stale ?? false;

  doc.set(next);
  doc.seriesId = doc.seriesId ?? (await resolveSeriesId(pm));
  doc.lastSyncedAt = now;
  doc.stale = false;
  if (pm.status !== 'UPCOMING' && !doc.startedAt) doc.startedAt = now;
  if (finished && !doc.endedAt) doc.endedAt = now;

  const newBalls = await insertNewBalls(doc._id, balls);
  if (changed || newBalls.length > 0 || !existing) {
    doc.currentState = computeCurrentState(innings, balls, existing?.currentState?.winProbabilityBps ?? null);
  }
  await doc.save();
  const saved = doc.toObject();
  const matchId = saved._id.toString();

  if (!changed && newBalls.length === 0 && existing) {
    if (wasStale) await publish('match.stale', { matchId, stale: false });
    return wasStale
      ? { matchId, match: saved, created: false, statusFrom, statusTo: saved.status, newBalls: [], scoreChanged: false, tossChanged: false, resultChanged: false, inningsCompleted: [], staleChanged: false }
      : null;
  }

  const view = toLiveView(saved);
  await cacheLiveView(view);
  await publish('match.updated', { matchId, view });
  for (const b of newBalls.slice(-MAX_BALL_EVENTS_PER_SYNC)) await publish('match.ball', { matchId, ball: toBallView(b) });
  if (statusFrom !== saved.status) await publish('match.status', { matchId, from: statusFrom, to: saved.status });
  if (wasStale) await publish('match.stale', { matchId, stale: false });

  const change: MatchChange = {
    matchId,
    match: saved,
    created: !existing,
    statusFrom,
    statusTo: saved.status,
    newBalls,
    scoreChanged: changed,
    tossChanged,
    resultChanged,
    inningsCompleted: innings.filter((i) => i.isComplete && !completedBefore.has(i.number)).map((i) => i.number),
    staleChanged: wasStale ? false : null,
  };
  await dispatchMatchChange(change);
  return change;
}

/** A successful provider poll with no changes still proves the data is fresh. */
export async function touchSynced(source: 'live' | 'replay', providerIds: string[]): Promise<void> {
  if (providerIds.length === 0) return;
  const filter = { 'providerRef.provider': source, 'providerRef.id': { $in: providerIds } };
  const reviving = await Match.find({ ...filter, stale: true }).select('_id').lean();
  await Match.updateMany(filter, { $set: { lastSyncedAt: new Date(), stale: false } });
  for (const m of reviving) {
    const doc = await Match.findById(m._id).lean();
    if (!doc) continue;
    const matchId = doc._id.toString();
    await cacheLiveView(toLiveView(doc));
    await publish('match.stale', { matchId, stale: false });
    await dispatchMatchChange({ matchId, match: doc, created: false, statusFrom: doc.status, statusTo: doc.status, newBalls: [], scoreChanged: false, tossChanged: false, resultChanged: false, inningsCompleted: [], staleChanged: false });
  }
}

/** In-progress matches not refreshed within the threshold are flagged stale (in-play markets suspend). */
export async function markStaleMatches(thresholdMs: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - thresholdMs);
  const stale = await Match.find({ status: { $in: ['TOSS', 'LIVE', 'INNINGS_BREAK', 'RAIN_DELAY'] }, stale: false, lastSyncedAt: { $lt: cutoff } }).lean();
  const ids: string[] = [];
  for (const m of stale) {
    const res = await Match.updateOne({ _id: m._id, stale: false }, { $set: { stale: true } });
    if (res.modifiedCount !== 1) continue;
    const doc = { ...m, stale: true };
    const matchId = m._id.toString();
    ids.push(matchId);
    await cacheLiveView(toLiveView(doc));
    await publish('match.stale', { matchId, stale: true });
    await dispatchMatchChange({ matchId, match: doc, created: false, statusFrom: m.status, statusTo: m.status, newBalls: [], scoreChanged: false, tossChanged: false, resultChanged: false, inningsCompleted: [], staleChanged: true });
  }
  return ids;
}
