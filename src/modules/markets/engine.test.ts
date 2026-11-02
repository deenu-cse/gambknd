import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getReplayStore } from '../../providers/cricket/index.js';
import { replayScripts } from '../../providers/cricket/replay/scripts.js';
import { createStaff, useTestApp } from '../../tests/helpers.js';
import { pollerTick, replayTick } from '../../workers/poller.js';
import { clearMatchChangeHandlers, registerMatchChangeHandler } from '../matches/matchEvents.js';
import { Match } from '../matches/match.model.js';
import { updateSettings } from '../settings/settings.service.js';
import { onMatchChange, reevaluateMatch, reopenAfterBall, setReopenScheduler } from './engine.js';
import { addExposure } from './liability.js';
import { Market } from './market.model.js';
import { isOnLadder } from './odds/ladder.js';
import { bookOverroundBps } from './odds/margin.js';

const { app } = useTestApp();
const script = replayScripts().find((s) => s.id.startsWith('2nd-match'))!;
let reopens: Array<{ matchId: string; token: string; delayMs: number }> = [];

beforeAll(() => {
  registerMatchChangeHandler('markets', onMatchChange);
  setReopenScheduler((matchId, token, delayMs) => {
    reopens.push({ matchId, token, delayMs });
    return Promise.resolve();
  });
});
afterAll(() => clearMatchChangeHandlers());
beforeEach(() => {
  reopens = [];
});

// Replay steps run on this simulated clock. Sessions start at clock + 1000 so each tick is exactly one step.
let clock = Date.now();
async function setup(startInSec = 3600) {
  clock = Date.now();
  const store = getReplayStore();
  const session = await store.create({ scriptId: script.id, intervalMs: 1000, startInSec, seed: 'test-seed' });
  await replayTick(clock);
  const match = (await Match.findOne({ 'providerRef.id': session.providerId }).lean())!;
  return { store, session, matchId: match._id.toString() };
}
async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    clock += 1000;
    await replayTick(clock);
  }
}
async function byKey(matchId: string) {
  const rows = await Market.find({ matchId }).lean();
  return new Map(rows.map((m) => [m.key, m]));
}
async function innings1(matchId: string) {
  return (await Match.findById(matchId).lean())!.innings[0];
}

describe('pre-match markets', () => {
  it('leaves real fixtures out of the featured picks in replay mode', async () => {
    const { matchId } = await setup();
    const featured = async () => {
      const res = await request(app()).get('/api/markets/featured').expect(200);
      return (res.body as { data: Array<{ match: { id: string } }> }).data.map((f) => f.match.id);
    };
    expect(await featured()).toContain(matchId);

    await Match.updateOne({ _id: matchId }, { $set: { source: 'live' } });
    expect(await featured()).not.toContain(matchId);

    await updateSettings({ providerMode: 'live' }, 'test');
    expect(await featured()).toContain(matchId);
  });

  it('creates and prices the full pre-match book', async () => {
    const { matchId } = await setup();
    const m = await byKey(matchId);
    const [a, b] = script.teams.map((t) => t.key);
    for (const key of ['MATCH_WINNER', 'TOSS_WINNER', 'INNINGS_TOTAL:1', 'SESSION_RUNS:1:6', 'SESSION_RUNS:1:20', `TOP_BATSMAN:${a}`, `TOP_BOWLER:${b}`, 'OPENING_PARTNERSHIP']) {
      expect(m.get(key)?.status, key).toBe('OPEN');
    }
    for (const market of m.values()) {
      expect(market.selections.every((s) => isOnLadder(s.odds))).toBe(true);
      expect(bookOverroundBps(market.selections.map((s) => s.odds))).toBeGreaterThanOrEqual(market.marginBps - 10);
    }
    expect(m.get('INNINGS_TOTAL:1')?.lineX10 ?? 0).toBeGreaterThan(0);
    expect((m.get('INNINGS_TOTAL:1')?.lineX10 ?? 0) % 10).toBe(5);
    expect(m.get('TOSS_WINNER')?.selections.map((s) => s.odds)).toEqual([190, 190]);
  });

  it('serves markets publicly without fair probabilities', async () => {
    const { matchId } = await setup();
    const res = await request(app()).get(`/api/matches/${matchId}/markets`).expect(200);
    expect(res.body.data.length).toBeGreaterThan(5);
    expect(JSON.stringify(res.body)).not.toMatch(/probabilityBps|marginBps|maxLiability/);
    const one = await request(app()).get(`/api/markets/${res.body.data[0].id as string}`).expect(200);
    expect(one.body.data.selections[0].odds).toBeGreaterThanOrEqual(101);
  });

  it('shortens a selection the house is exposed on', async () => {
    const { matchId } = await setup();
    const mw = (await byKey(matchId)).get('MATCH_WINNER')!;
    const [a, b] = mw.selections;
    await addExposure(mw._id.toString(), a!.id, 1_000_00, mw.maxLiability + 1_000_00);
    await reevaluateMatch(matchId);
    const after = (await byKey(matchId)).get('MATCH_WINNER')!;
    expect(after.selections[0]!.odds).toBeLessThan(a!.odds);
    expect(after.selections[1]!.odds).toBeGreaterThanOrEqual(b!.odds);
  });
});

describe('in-play lifecycle', () => {
  it('closes toss and pre-match-only markets at the right moments', async () => {
    const { store, session, matchId } = await setup();
    await store.control(session.id, 'start', clock + 1000);
    await tick(); // toss
    let m = await byKey(matchId);
    expect(m.get('TOSS_WINNER')?.status).toBe('CLOSED');
    expect(m.get(`TOP_BATSMAN:${script.teams[0].key}`)?.status).toBe('OPEN');
    await tick(); // first ball
    m = await byKey(matchId);
    expect(m.get(`TOP_BATSMAN:${script.teams[0].key}`)?.status).toBe('CLOSED');
    expect(m.get('MATCH_WINNER')?.status).toBe('SUSPENDED');
  });

  it('suspends on every ball and reopens only for the latest delivery', async () => {
    const { store, session, matchId } = await setup();
    await store.control(session.id, 'start', clock + 1000);
    await tick(2); // toss + ball 1
    const mw1 = (await byKey(matchId)).get('MATCH_WINNER')!;
    expect(['BALL', 'BOUNDARY', 'WICKET']).toContain(mw1.suspendReason);
    const first = reopens.at(-1)!;
    expect(first.delayMs).toBeGreaterThanOrEqual(3000);

    await tick(); // ball 2 arrives before the first reopen fires
    await reopenAfterBall(matchId, first.token);
    expect((await byKey(matchId)).get('MATCH_WINNER')?.status).toBe('SUSPENDED');

    await reopenAfterBall(matchId, reopens.at(-1)!.token);
    const mw = (await byKey(matchId)).get('MATCH_WINNER')!;
    expect(mw.status).toBe('OPEN');
    expect(mw.version).toBeGreaterThan(mw1.version);
    expect((await Match.findById(matchId).lean())?.currentState?.winProbabilityBps).toBeGreaterThan(0);
  });

  it('runs next-over, session and wicket markets through their lifecycles', async () => {
    const { store, session, matchId } = await setup();
    await store.control(session.id, 'start', clock + 1000);
    await tick(1); // toss
    // Play until the first over is complete.
    while (((await innings1(matchId))?.balls ?? 0) < 6) await tick();
    let m = await byKey(matchId);
    const nextOver = m.get('NEXT_OVER_RUNS:1:1');
    expect(nextOver?.status).toBe('SUSPENDED'); // created on the ball that ended the over
    await tick(); // first ball of over 2
    m = await byKey(matchId);
    expect(m.get('NEXT_OVER_RUNS:1:1')?.status).toBe('CLOSED');

    // Overs 1–6 session closes when the 6th over starts (30 legal balls bowled).
    while (((await innings1(matchId))?.balls ?? 0) < 30) await tick();
    m = await byKey(matchId);
    expect(m.get('SESSION_RUNS:1:6')?.status).toBe('CLOSED');
    expect(m.get('SESSION_RUNS:1:10')?.status).not.toBe('CLOSED');

    // First wicket: its fall/dismissal markets close and the next wicket's open.
    const firstWicketFell = async () => ((await innings1(matchId))?.wickets ?? 0) >= 1;
    for (let i = 0; i < 200 && !(await firstWicketFell()); i += 1) await tick();
    if (await firstWicketFell()) {
      m = await byKey(matchId);
      expect(m.get('FALL_OF_NEXT_WICKET:1:1')?.status).toBe('CLOSED');
      expect(m.get('DISMISSAL_METHOD:1:1')?.status).toBe('CLOSED');
      expect(m.has('FALL_OF_NEXT_WICKET:1:2')).toBe(true);
    }
  });

  it('suspends in-play markets when data goes stale and recovers afterwards', async () => {
    await updateSettings({ staleThresholdMs: 5_000 }, 'test');
    const { store, session, matchId } = await setup();
    await store.control(session.id, 'start', clock + 1000);
    await tick(3);
    await store.control(session.id, 'outage_on', clock);
    await Match.updateOne({ _id: matchId }, { $set: { lastSyncedAt: new Date(Date.now() - 60_000) } });
    await pollerTick(clock + 1000);
    const stale = await byKey(matchId);
    expect(stale.get('MATCH_WINNER')?.suspendReason).toBe('STALE');
    expect(stale.get('INNINGS_TOTAL:1')?.suspendReason).toBe('STALE');

    await store.control(session.id, 'outage_off', clock);
    await pollerTick(clock + 2000);
    expect((await byKey(matchId)).get('MATCH_WINNER')?.suspendReason).not.toBe('STALE');
  });

  it('closes every market when the match ends', async () => {
    const { store, session, matchId } = await setup();
    await store.control(session.id, 'start', clock + 1000);
    await tick(5);
    await store.control(session.id, 'finish', clock);
    await tick();
    const rows = await Market.find({ matchId }).lean();
    expect(rows.every((r) => r.status === 'CLOSED')).toBe(true);
  });
});

describe('admin market controls', () => {
  async function admin() {
    const staff = await createStaff('admin');
    const agent = request.agent(app());
    await agent.post('/api/admin/auth/login').send({ email: staff.email, password: staff.password }).expect(200);
    return agent;
  }

  it('manual suspension is sticky until an admin reopens', async () => {
    const { matchId } = await setup();
    const agent = await admin();
    const mw = (await byKey(matchId)).get('MATCH_WINNER')!;
    await agent.post(`/api/admin/markets/${mw._id.toString()}/suspend`).send({ reason: 'Suspicious volume' }).expect(200);
    await reevaluateMatch(matchId);
    expect((await byKey(matchId)).get('MATCH_WINNER')?.suspendReason).toBe('ADMIN');
    await agent.post(`/api/admin/markets/${mw._id.toString()}/reopen`).send({ reason: 'Checked, fine' }).expect(200);
    expect((await byKey(matchId)).get('MATCH_WINNER')?.status).toBe('OPEN');
  });

  it('disabling betting on a match suspends its markets; re-enabling reopens them', async () => {
    const { matchId } = await setup();
    const agent = await admin();
    await agent.patch(`/api/admin/matches/${matchId}`).send({ bettingEnabled: false, reason: 'Integrity check' }).expect(200);
    expect((await byKey(matchId)).get('MATCH_WINNER')?.suspendReason).toBe('BETTING_DISABLED');
    await agent.patch(`/api/admin/matches/${matchId}`).send({ bettingEnabled: true, reason: 'Cleared' }).expect(200);
    expect((await byKey(matchId)).get('MATCH_WINNER')?.status).toBe('OPEN');
  });

  it('edits margins and limits, and creates hand-priced custom markets', async () => {
    const { matchId } = await setup();
    const agent = await admin();
    const mw = (await byKey(matchId)).get('MATCH_WINNER')!;
    await agent.patch(`/api/admin/markets/${mw._id.toString()}`).send({ marginBps: 1500, maxStake: 5_000_00, reason: 'Thin market' }).expect(200);
    const edited = (await byKey(matchId)).get('MATCH_WINNER')!;
    expect(edited.maxStake).toBe(5_000_00);
    expect(bookOverroundBps(edited.selections.map((s) => s.odds))).toBeGreaterThanOrEqual(1490);

    const created = await agent
      .post(`/api/admin/matches/${matchId}/markets`)
      .send({ name: 'Super Over in match?', inPlay: false, selections: [{ name: 'Yes', odds: 1500 }, { name: 'No', odds: 103 }], reason: 'Fan request' })
      .expect(201);
    const id = created.body.data.id as string;
    expect(created.body.data).toMatchObject({ status: 'SUSPENDED', suspendReason: 'ADMIN', autoManaged: false });
    await agent.post(`/api/admin/markets/${id}/reopen`).send({ reason: 'Reviewed' }).expect(200);
    const custom = await Market.findById(id).lean();
    expect(custom?.status).toBe('OPEN');
    expect(custom?.selections.map((s) => s.odds)).toEqual([1500, 103]); // never repriced
    const list = await agent.get(`/api/admin/matches/${matchId}/markets`).expect(200);
    expect(list.body.data[0]).toHaveProperty('probabilitiesBps');
  });
});
