import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { getReplayStore } from '../../providers/cricket/index.js';
import { replayScripts } from '../../providers/cricket/replay/scripts.js';
import { createStaff, useTestApp } from '../../tests/helpers.js';
import { pollerTick, replayTick } from '../../workers/poller.js';
import { BallEventModel, Match } from './match.model.js';
import { updateSettings } from '../settings/settings.service.js';

const { app } = useTestApp();
const script = replayScripts().find((s) => !s.scoreSynthesized)!;

async function startReplay(intervalMs = 1000) {
  const store = getReplayStore();
  const session = await store.create({ scriptId: script.id, intervalMs, startInSec: 3600, seed: 'test-seed' });
  return { store, session };
}

/** Drives the poller with a simulated clock: one delivery per tick. */
async function advance(ticks: number, from: number, intervalMs = 1000): Promise<number> {
  let now = from;
  for (let i = 0; i < ticks; i += 1) {
    now += intervalMs;
    await replayTick(now);
  }
  return now;
}

describe('replay → poller → database', () => {
  it('creates the match as UPCOMING, then plays toss and deliveries', async () => {
    const { store, session } = await startReplay();
    await replayTick(Date.now());
    let match = await Match.findOne({ 'providerRef.id': session.providerId }).lean();
    expect(match).toMatchObject({ status: 'UPCOMING', source: 'replay', bettingEnabled: true });
    expect(match?.teams.map((t) => t.key)).toEqual(script.teams.map((t) => t.key));

    await store.control(session.id, 'start');
    let now = Date.now();
    await replayTick(now); // toss step
    match = await Match.findOne({ 'providerRef.id': session.providerId }).lean();
    expect(match?.status).toBe('TOSS');
    expect(match?.toss).toEqual(script.toss);

    now = await advance(12, now);
    match = await Match.findOne({ 'providerRef.id': session.providerId }).lean();
    expect(match?.status).toBe('LIVE');
    const balls = await BallEventModel.countDocuments({ matchId: match!._id });
    expect(balls).toBe(12);
    const inn = match!.innings[0]!;
    expect(inn.batting.length).toBeGreaterThanOrEqual(2);
    expect(match!.currentState).toMatchObject({ inningsNumber: 1, battingTeamKey: script.plan[0].battingKey });
    expect(match!.currentState!.lastSixBalls).toHaveLength(6);
    expect(match!.currentState!.runs).toBe(inn.runs);

    // Same state again: nothing duplicates.
    await replayTick(now);
    expect(await BallEventModel.countDocuments({ matchId: match!._id })).toBe(12);
  });

  it('finishes with the real result and every delivery stored', async () => {
    const { store, session } = await startReplay();
    await store.control(session.id, 'start');
    await replayTick(Date.now());
    await store.control(session.id, 'finish');
    await replayTick(Date.now() + 1000);
    const match = await Match.findOne({ 'providerRef.id': session.providerId }).lean();
    expect(match).toMatchObject({ status: 'COMPLETED', statusText: script.resultText, result: { winnerKey: script.result.winnerKey } });
    expect(match!.innings.map((i) => [i.runs, i.wickets, i.balls])).toEqual(script.plan.map((p) => [p.runs, p.wickets, p.balls]));
    expect(match!.endedAt).toBeTruthy();
  });

  it('abandon produces an ABANDONED match', async () => {
    const { store, session } = await startReplay();
    await store.control(session.id, 'start');
    await advance(5, Date.now());
    await store.control(session.id, 'abandon');
    await replayTick(Date.now() + 10_000);
    const match = await Match.findOne({ 'providerRef.id': session.providerId }).lean();
    expect(match?.status).toBe('ABANDONED');
    expect(match?.result?.type).toBe('ABANDONED');
  });

  it('rain pause shows RAIN_DELAY and stays fresh', async () => {
    const { store, session } = await startReplay();
    await store.control(session.id, 'start');
    const now = await advance(3, Date.now());
    await store.control(session.id, 'rain');
    await replayTick(now + 1000);
    const match = await Match.findOne({ 'providerRef.id': session.providerId }).lean();
    expect(match).toMatchObject({ status: 'RAIN_DELAY', stale: false });
  });

  it('a provider outage marks the match stale, and recovery clears it', async () => {
    await updateSettings({ staleThresholdMs: 5_000 }, 'test');
    const { store, session } = await startReplay();
    await store.control(session.id, 'start');
    const now = await advance(3, Date.now());
    await store.control(session.id, 'outage_on');
    await Match.updateOne({ 'providerRef.id': session.providerId }, { $set: { lastSyncedAt: new Date(Date.now() - 60_000) } });
    await pollerTick(now + 1000);
    expect((await Match.findOne({ 'providerRef.id': session.providerId }).lean())?.stale).toBe(true);

    await store.control(session.id, 'outage_off');
    await pollerTick(now + 2000);
    expect((await Match.findOne({ 'providerRef.id': session.providerId }).lean())?.stale).toBe(false);
  });
});

describe('public match API', () => {
  async function liveMatchId(): Promise<string> {
    const { store, session } = await startReplay();
    await store.control(session.id, 'start');
    await advance(20, Date.now());
    const m = await Match.findOne({ 'providerRef.id': session.providerId }).lean();
    return m!._id.toString();
  }

  it('lists by bucket and serves the live view', async () => {
    const id = await liveMatchId();
    const list = await request(app()).get('/api/matches?bucket=live').expect(200);
    expect(list.body.data.map((m: { id: string }) => m.id)).toContain(id);
    expect(list.body.data[0]).not.toHaveProperty('squads');

    const detail = await request(app()).get(`/api/matches/${id}`).expect(200);
    expect(detail.body.data).toMatchObject({ id, status: 'LIVE', source: 'replay' });
    // Right after a wicket the incoming batter is unknown, so only one crease slot is guaranteed.
    const cs = detail.body.data.currentState;
    expect(cs.striker ?? cs.nonStriker).toBeTruthy();
    expect(cs.balls).toBeGreaterThan(0);
    expect(JSON.stringify(detail.body)).not.toMatch(/apikey|providerRef/);
  });

  it('hides real fixtures in replay mode, because nothing updates them', async () => {
    const id = await liveMatchId();
    await Match.updateOne({ _id: id }, { $set: { source: 'live' } });
    const ids = async () => {
      const res = await request(app()).get('/api/matches?bucket=live').expect(200);
      return (res.body as { data: Array<{ id: string }> }).data.map((m) => m.id);
    };

    expect(await ids()).not.toContain(id);

    await updateSettings({ providerMode: 'live' }, 'test');
    expect(await ids()).toContain(id);
  });

  it('pages commentary newest-first and serves scorecard, overs and squads', async () => {
    const id = await liveMatchId();
    const first = await request(app()).get(`/api/matches/${id}/commentary?limit=5`).expect(200);
    expect(first.body.data).toHaveLength(5);
    const seqs = first.body.data.map((b: { seq: number }) => b.seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => b - a));
    const next = await request(app()).get(`/api/matches/${id}/commentary?limit=5&cursor=${first.body.meta.nextCursor as string}`).expect(200);
    expect(next.body.data[0].seq).toBeLessThan(seqs.at(-1));

    const card = await request(app()).get(`/api/matches/${id}/scorecard`).expect(200);
    expect(card.body.data.innings[0].batting.length).toBeGreaterThan(0);
    const overs = await request(app()).get(`/api/matches/${id}/overs`).expect(200);
    expect(overs.body.data[0].overs.length).toBeGreaterThan(0);
    const squads = await request(app()).get(`/api/matches/${id}/squads`).expect(200);
    expect(squads.body.data).toHaveLength(2);
    const pid = squads.body.data[0].players[0].playerId as string;
    const player = await request(app()).get(`/api/players/${pid}`).expect(200);
    expect(player.body.data.stats.batting.T20.matches).toBeGreaterThan(0);
  });

  it('404s cleanly for unknown ids', async () => {
    await request(app()).get('/api/matches/000000000000000000000000').expect(404);
    await request(app()).get('/api/matches/not-an-id').expect(404);
  });
});

describe('admin replay controls', () => {
  it('creates and drives a replay session, with an audit trail', async () => {
    const staff = await createStaff('admin');
    const admin = request.agent(app());
    await admin.post('/api/admin/auth/login').send({ email: staff.email, password: staff.password }).expect(200);

    const scripts = await admin.get('/api/admin/replay/scripts').expect(200);
    expect(scripts.body.data.length).toBe(13);
    const created = await admin.post('/api/admin/replay/sessions').send({ scriptId: script.id, intervalMs: 2000, startInSec: 60 }).expect(201);
    const sid = created.body.data.id as string;
    await admin.post(`/api/admin/replay/sessions/${sid}/start`).set('X-Requested-With', 'fetch').expect(200);
    await admin.post(`/api/admin/replay/sessions/${sid}/speed`).send({ intervalMs: 500 }).expect(200);
    await admin.post(`/api/admin/replay/sessions/${sid}/explode`).set('X-Requested-With', 'fetch').expect(400);
    const health = await admin.get('/api/admin/system/provider').expect(200);
    expect(health.body.data).toMatchObject({ providerMode: 'replay' });
    expect(health.body.data.budget.limit).toBeGreaterThan(0);
  });
});
