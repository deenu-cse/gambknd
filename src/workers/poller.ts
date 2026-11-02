import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRedis } from '../config/redis.js';
import { Match } from '../modules/matches/match.model.js';
import { markStaleMatches, syncMatch, touchSynced } from '../modules/matches/sync.service.js';
import { getSettings } from '../modules/settings/settings.service.js';
import { getHitBudget, getLiveProvider, getReplayProvider, getReplayStore, ProviderError } from '../providers/cricket/index.js';
import { IN_PROGRESS_STATUSES, type Innings } from '../providers/cricket/types.js';

const KEYS = {
  replayFp: 'poll:fp:replay',
  liveFp: 'poll:fp:live',
  liveNext: 'poll:live:next',
  fixturesNext: 'poll:live:fixtures-next',
  lastTick: 'poll:last-tick',
};
const MAX_LIVE_DETAILS_PER_TICK = 10;

/** Moves replay sessions forward and syncs every replay match whose state changed. */
export async function replayTick(now = Date.now()): Promise<number> {
  const store = getReplayStore();
  const provider = getReplayProvider();
  const redis = getRedis();
  await store.advanceAll(now);
  const sessions = await store.list(100);
  const prev = await redis.hgetall(KEYS.replayFp);
  const unchanged: string[] = [];
  let synced = 0;
  for (const s of sessions) {
    // Simulated outage: no fetch, no touch, so the match goes stale and in-play markets suspend.
    if (s.outage) continue;
    const fp = [s.status, s.cursor, s.pauseReason ?? '', s.abandoned ? 'A' : ''].join('|');
    if (prev[s.providerId] === fp) {
      if (s.status !== 'finished') unchanged.push(s.providerId);
      continue;
    }
    try {
      const [match, balls] = await Promise.all([provider.getMatchDetail(s.providerId), provider.getBallByBall(s.providerId)]);
      await syncMatch(match, { balls });
      await redis.hset(KEYS.replayFp, s.providerId, fp);
      synced += 1;
    } catch (err) {
      logger.error({ err, providerId: s.providerId }, 'replay sync failed');
    }
  }
  await touchSynced('replay', unchanged);
  return synced;
}

async function syncLiveFixtures(now: number): Promise<void> {
  const live = getLiveProvider();
  const redis = getRedis();
  if (!live || now < Number((await redis.get(KEYS.fixturesNext)) ?? 0)) return;
  await redis.set(KEYS.fixturesNext, String(now + env.FIXTURE_SYNC_MS));
  for (const m of await live.getMatches()) await syncMatch(m);
}

/**
 * Live CricAPI polling. One `cricScore` call detects changes across every match; detail,
 * ball-by-ball and scorecard calls are spent only on matches that changed. The interval adapts
 * to the remaining daily hit budget (API_CONTRACT §6).
 */
export async function liveTick(now = Date.now()): Promise<void> {
  const live = getLiveProvider();
  const settings = await getSettings();
  if (!live || settings.providerMode !== 'live') return;
  const redis = getRedis();
  const budget = getHitBudget();
  try {
    await syncLiveFixtures(now);
    if (now < Number((await redis.get(KEYS.liveNext)) ?? 0)) return;

    const ticks = await live.getLiveScore();
    const prev = await redis.hgetall(KEYS.liveFp);
    const known = new Set(
      (await Match.find({ source: 'live', 'providerRef.id': { $in: ticks.map((t) => t.providerId) } }).select('providerRef.id').lean()).map((m) => m.providerRef.id),
    );
    const changed = ticks.filter((t) => prev[t.providerId] !== t.fingerprint && (t.phase !== 'fixture' || known.has(t.providerId)));
    const caps = live.capabilities();

    for (const t of changed.slice(0, MAX_LIVE_DETAILS_PER_TICK)) {
      const detail = await live.getMatchDetail(t.providerId);
      const inPlay = IN_PROGRESS_STATUSES.includes(detail.status);
      const balls = caps.ballByBall && detail.capabilities.ballByBall && inPlay ? await live.getBallByBall(t.providerId) : [];
      const wantCard = caps.scorecard && (detail.status === 'COMPLETED' || detail.status === 'INNINGS_BREAK');
      const scorecard: Innings[] | undefined = wantCard ? await live.getScorecard(t.providerId) : undefined;
      await syncMatch(detail, { balls, ...(scorecard ? { scorecard } : {}) });
      await redis.hset(KEYS.liveFp, t.providerId, t.fingerprint);
    }
    const confirmed = ticks.filter((t) => t.phase === 'live' && prev[t.providerId] === t.fingerprint).map((t) => t.providerId);
    await touchSynced('live', confirmed);

    const liveCount = ticks.filter((t) => t.phase === 'live').length;
    const interval = liveCount > 0 ? await budget.recommendedIntervalMs(1 + liveCount * (caps.ballByBall ? 2 : 1), env.LIVE_POLL_MIN_MS) : env.UPCOMING_POLL_MS;
    await redis.set(KEYS.liveNext, String(now + interval));
  } catch (err) {
    if (err instanceof ProviderError) {
      const backoff = err.kind === 'BUDGET_EXHAUSTED' ? (await budget.usage()).resetsAt.getTime() - now : err.kind === 'CIRCUIT_OPEN' ? 30_000 : 10_000;
      await redis.set(KEYS.liveNext, String(now + Math.max(5_000, backoff)));
      logger.warn({ kind: err.kind, msg: err.message, backoffMs: backoff }, 'live poll skipped');
      return;
    }
    throw err;
  }
}

/** One poller heartbeat: replay, live, then the stale-data sweep. */
export async function pollerTick(now = Date.now()): Promise<void> {
  await replayTick(now);
  await liveTick(now);
  const settings = await getSettings();
  await markStaleMatches(settings.staleThresholdMs);
  await getRedis().set(KEYS.lastTick, String(now));
}

export async function pollerStatus(): Promise<{ lastTickAt: Date | null; liveNextAt: Date | null; fixturesNextAt: Date | null }> {
  const [last, next, fixtures] = await getRedis().mget(KEYS.lastTick, KEYS.liveNext, KEYS.fixturesNext);
  const d = (v: string | null) => (v ? new Date(Number(v)) : null);
  return { lastTickAt: d(last ?? null), liveNextAt: d(next ?? null), fixturesNextAt: d(fixtures ?? null) };
}
