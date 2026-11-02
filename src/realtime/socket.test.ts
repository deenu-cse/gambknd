import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getReplayStore } from '../providers/cricket/index.js';
import { replayScripts } from '../providers/cricket/replay/scripts.js';
import { createStaff, extractCookie, registerAgent, useTestApp } from '../tests/helpers.js';
import { replayTick } from '../workers/poller.js';
import { Match } from '../modules/matches/match.model.js';
import { attachSocketServer } from './socket.js';
import { clearMatchChangeHandlers, registerMatchChangeHandler } from '../modules/matches/matchEvents.js';
import { onMatchChange, setReopenScheduler } from '../modules/markets/engine.js';

const { app } = useTestApp();
let http: HttpServer;
let close: () => Promise<void>;
let base = '';

beforeAll(async () => {
  http = createServer(app());
  ({ close } = await attachSocketServer(http));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await close();
  await new Promise<void>((r) => http.close(() => r()));
});

function once<T>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

describe('socket realtime', () => {
  it('/live pushes score and ball events to subscribed match rooms', async () => {
    const store = getReplayStore();
    const session = await store.create({ scriptId: replayScripts()[0]!.id, intervalMs: 1000, startInSec: 0, seed: 'test-seed' });
    await store.control(session.id, 'start');
    let now = Date.now();
    await replayTick(now);
    const match = await Match.findOne({ 'providerRef.id': session.providerId }).lean();
    const room = `match:${match!._id.toString()}`;

    const socket = connect(`${base}/live`, { transports: ['websocket'], forceNew: true });
    const ack = await new Promise<{ ok: boolean; rooms: string[] }>((resolve) => socket.emit('subscribe', { rooms: [room, 'user:hijack', 'admin'] }, resolve));
    expect(ack).toEqual({ ok: true, rooms: [room] }); // only public match/market rooms are joinable

    const score = once<{ id: string; status: string }>(socket, 'score:update');
    const ball = once<{ seq: number; commentary: string }>(socket, 'ball:event');
    now += 1000;
    await replayTick(now);
    expect((await score).id).toBe(match!._id.toString());
    expect((await ball).commentary.length).toBeGreaterThan(0);
    socket.close();
  });

  it('/live pushes market suspensions and odds to the match room', async () => {
    registerMatchChangeHandler('markets', onMatchChange);
    setReopenScheduler(() => Promise.resolve());
    const store = getReplayStore();
    const session = await store.create({ scriptId: replayScripts()[0]!.id, intervalMs: 1000, startInSec: 0, seed: 'test-seed' });
    let now = Date.now();
    await replayTick(now);
    const match = await Match.findOne({ 'providerRef.id': session.providerId }).lean();
    const socket = connect(`${base}/live`, { transports: ['websocket'], forceNew: true });
    await new Promise((resolve) => socket.emit('subscribe', { rooms: [`match:${match!._id.toString()}`] }, resolve));

    const suspended = once<{ marketId: string; reason: string }>(socket, 'market:suspended');
    const update = once<{ id: string; status: string; selections: Array<{ odds: number }> }>(socket, 'market:update');
    await store.control(session.id, 'start');
    now += 2000;
    await replayTick(now); // toss + first delivery
    expect((await update).selections[0]!.odds).toBeGreaterThanOrEqual(101);
    expect(['BALL', 'BOUNDARY', 'WICKET']).toContain((await suspended).reason);
    socket.close();
    clearMatchChangeHandlers();
  });

  it('/user requires a valid token and pushes wallet updates to the owner only', async () => {
    const anon = connect(`${base}/user`, { transports: ['websocket'], forceNew: true });
    const err = await once<Error>(anon, 'connect_error');
    expect(err.message).toBe('UNAUTHENTICATED');
    anon.close();

    const { agent } = await registerAgent(app());
    const login = await agent.post('/api/auth/refresh').set('X-Requested-With', 'fetch').expect(200);
    const token = extractCookie(login, 'gamb_at').split('=')[1];
    const socket = connect(`${base}/user`, { transports: ['websocket'], forceNew: true, auth: { token } });
    await once(socket, 'connect');
    const update = once<{ balance: number }>(socket, 'wallet:update');
    await agent.post('/api/wallet/daily-bonus').set('X-Requested-With', 'fetch').expect(200);
    expect((await update).balance).toBeGreaterThan(0);
    socket.close();
  });

  it('counts connected sockets on the admin KPIs, and force logout drops them', async () => {
    const player = await registerAgent(app());
    const refreshed = await player.agent.post('/api/auth/refresh').set('X-Requested-With', 'fetch').expect(200);
    const token = extractCookie(refreshed, 'gamb_at').split('=')[1];
    const first = connect(`${base}/user`, { transports: ['websocket'], forceNew: true, auth: { token } });
    const second = connect(`${base}/user`, { transports: ['websocket'], forceNew: true, auth: { token } });
    await Promise.all([once(first, 'connect'), once(second, 'connect')]);

    const staff = await createStaff('admin');
    const admin = request.agent(http);
    await admin.post('/api/admin/auth/login').send({ email: staff.email, password: staff.password }).expect(200);

    const overview = (await admin.get('/api/admin/overview').expect(200)).body as { data: { users: { activeNow: number } } };
    expect(overview.data.users.activeNow).toBe(1); // two tabs, one player
    const health = (await admin.get('/api/admin/system/health').expect(200)).body as { data: { sockets: { user: number } } };
    expect(health.data.sockets.user).toBe(2);

    const dropped = once<string>(first, 'disconnect');
    await admin.post(`/api/admin/users/${player.userId}/force-logout`).send({ reason: 'Session review' }).expect(200);
    expect(await dropped).toBe('io server disconnect');
    second.close();
  });

  it('/admin rejects user-realm tokens', async () => {
    const { agent } = await registerAgent(app());
    const res = await agent.post('/api/auth/refresh').set('X-Requested-With', 'fetch').expect(200);
    const token = extractCookie(res, 'gamb_at').split('=')[1];
    const socket = connect(`${base}/admin`, { transports: ['websocket'], forceNew: true, auth: { token } });
    expect((await once<Error>(socket, 'connect_error')).message).toBe('UNAUTHENTICATED');
    socket.close();
  });
});
