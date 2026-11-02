import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getReplayStore } from '../../providers/cricket/index.js';
import { replayScripts } from '../../providers/cricket/replay/scripts.js';
import { createStaff, registerAgent, useTestApp } from '../../tests/helpers.js';
import { replayTick } from '../../workers/poller.js';
import { AuditLog } from '../audit/audit.model.js';
import { onMatchChange, reopenAfterBall, setReopenScheduler } from '../markets/engine.js';
import { getBook } from '../markets/liability.js';
import { Market, type IMarket } from '../markets/market.model.js';
import { suspendMarket } from '../markets/market.service.js';
import { clearMatchChangeHandlers, registerMatchChangeHandler } from '../matches/matchEvents.js';
import { Match } from '../matches/match.model.js';
import { DEFAULT_SETTINGS } from '../settings/settings.model.js';
import { LedgerEntry } from '../wallet/ledger.model.js';
import { runReconciliation } from '../wallet/reconciliation.service.js';
import { Bet } from './bet.model.js';
import { acceptPendingBet, placeBet, setAcceptanceScheduler } from './placement.service.js';

const { app } = useTestApp();
const WELCOME = DEFAULT_SETTINGS.welcomeBonus;
const scripts = replayScripts();
const acceptJobs: Array<{ betId: string; delayMs: number }> = [];
const reopenTokens: string[] = [];

beforeAll(() => {
  registerMatchChangeHandler('markets', onMatchChange);
  setReopenScheduler((_m, token) => {
    reopenTokens.push(token);
    return Promise.resolve();
  });
  setAcceptanceScheduler((betId, delayMs) => {
    acceptJobs.push({ betId, delayMs });
    return Promise.resolve();
  });
});
afterAll(() => clearMatchChangeHandlers());

// Replay steps run on this simulated clock. Sessions start at clock + 1000 so each tick is exactly one step.
let clock = Date.now();
async function preMatch(scriptIndex = 0) {
  clock = Date.now();
  const store = getReplayStore();
  const session = await store.create({ scriptId: scripts[scriptIndex]!.id, intervalMs: 1000, startInSec: 3600, seed: 'test-seed' });
  await replayTick(clock);
  const match = (await Match.findOne({ 'providerRef.id': session.providerId }).lean())!;
  return { store, session, matchId: match._id.toString() };
}
async function market(matchId: string, key: string): Promise<IMarket> {
  return (await Market.findOne({ matchId, key }).lean())!;
}
async function wallet(agent: request.Agent) {
  return (await agent.get('/api/wallet').expect(200)).body.data as { balance: number; locked: number; available: number };
}
function slip(m: IMarket, stake: number, sel = 0, oddsDelta = 0) {
  const s = m.selections[sel]!;
  return { marketId: m._id.toString(), selectionId: s.id, odds: s.odds + oddsDelta, stake, idempotencyKey: randomUUID() };
}

describe('pre-match singles', () => {
  it('accepts instantly, locks the stake through the ledger and updates the book', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    const res = await agent.post('/api/bets').send(slip(mw, 100_00)).expect(201);
    expect(res.body.data).toMatchObject({ status: 'ACCEPTED', stake: 100_00, odds: mw.selections[0]!.odds, kind: 'SINGLE' });
    expect(res.body.data.potentialReturn).toBe(Math.floor((100_00 * mw.selections[0]!.odds) / 100));
    expect(await wallet(agent)).toMatchObject({ balance: WELCOME, locked: 100_00, available: WELCOME - 100_00 });
    expect(await LedgerEntry.countDocuments({ idempotencyKey: `stake:${res.body.data.id as string}` })).toBe(2);
    const book = await getBook(mw._id.toString(), mw.selections.map((s) => s.id));
    expect(book.totalStake).toBe(100_00);
    expect(book.worstCaseLoss[mw.selections[0]!.id]).toBe(res.body.data.potentialReturn - 100_00);
  });

  it('is idempotent per key, and refuses a reused key with a different bet', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const body = slip(await market(matchId, 'MATCH_WINNER'), 50_00);
    const first = await agent.post('/api/bets').send(body).expect(201);
    const again = await agent.post('/api/bets').send(body).expect(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.body.meta.duplicate).toBe(true);
    expect(await Bet.countDocuments({})).toBe(1);
    expect((await wallet(agent)).locked).toBe(50_00);
    await agent.post('/api/bets').send({ ...body, stake: 60_00 }).expect(409);
  });

  it('20 parallel bets cannot overspend the wallet', async () => {
    const { matchId } = await preMatch();
    const { agent, userId } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => placeBet({ userId, ip: null, userAgent: null }, { legs: [{ marketId: mw._id.toString(), selectionId: mw.selections[0]!.id, odds: mw.selections[0]!.odds }], stake: 70_00, idempotencyKey: randomUUID() })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(14); // 1,000 tokens / 70 = 14
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r).reason.code === 'INSUFFICIENT_BALANCE')).toBe(true);
    const w = await wallet(agent);
    expect(w.locked).toBe(14 * 70_00);
    expect(w.available).toBeGreaterThanOrEqual(0);
    expect(await Bet.countDocuments({ userId })).toBe(14);
  });

  it('rate-limits a burst of HTTP bet requests', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    const res = await Promise.all(Array.from({ length: 12 }, () => agent.post('/api/bets').send(slip(mw, 10_00))));
    expect(res.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(2);
  });

  it('rejects when odds moved against the user, and takes better odds only if allowed', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    const worse = await agent.post('/api/bets').send(slip(mw, 10_00, 0, +10)).expect(409);
    expect(worse.body.error.code).toBe('ODDS_CHANGED');
    expect(worse.body.error.details.legs[0]).toMatchObject({ current: mw.selections[0]!.odds });

    const better = slip(mw, 10_00, 0, -5); // asked for less than offered
    await agent.post('/api/bets').send({ ...better, acceptBetterOdds: false }).expect(409);
    const taken = await agent.post('/api/bets').send({ ...better, idempotencyKey: randomUUID(), acceptBetterOdds: true }).expect(201);
    expect(taken.body.data.odds).toBe(mw.selections[0]!.odds);
    expect(taken.body.data.legs[0].requestedOdds).toBe(mw.selections[0]!.odds - 5);
  });

  it('rejects suspended markets, inactive selections and out-of-range stakes', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    await agent.post('/api/bets').send(slip(mw, 1)).expect(422); // below min
    await agent.post('/api/bets').send(slip(mw, DEFAULT_SETTINGS.globalMaxStake + 1)).expect(422);
    await agent.post('/api/bets').send({ ...slip(mw, 10_00), selectionId: 'nobody' }).expect(422);
    await suspendMarket({ id: null, role: 'system' }, mw._id.toString(), 'test');
    const res = await agent.post('/api/bets').send(slip(mw, 10_00)).expect(422);
    expect(res.body.error.code).toBe('MARKET_SUSPENDED');
  });

  it("enforces the user's own limits and breaks", async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    await agent.put('/api/users/me/responsible-play').send({ dailyStakeLimit: 100_00, dailyLossLimit: null, sessionReminderMinutes: null }).expect(200);
    await agent.post('/api/bets').send(slip(mw, 80_00)).expect(201);
    const over = await agent.post('/api/bets').send(slip(mw, 30_00)).expect(422);
    expect(over.body.error.code).toBe('RESPONSIBLE_PLAY_LIMIT');
    await agent.post('/api/users/me/break').send({ duration: '24h' }).expect(200);
    const res = await agent.post('/api/bets').send(slip(mw, 10_00)).expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_IN_COOLDOWN');
  });
});

describe('in-play bet delay', () => {
  async function liveOpenMatch() {
    const ctx = await preMatch();
    await ctx.store.control(ctx.session.id, 'start', clock + 1000);
    clock += 1000;
    await replayTick(clock); // toss
    clock += 1000;
    await replayTick(clock); // first ball → suspended
    await reopenAfterBall(ctx.matchId, reopenTokens.at(-1)!);
    return ctx;
  }

  it('holds the bet for the delay, then accepts it if nothing happened', async () => {
    const { matchId } = await liveOpenMatch();
    const { agent } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    expect(mw.status).toBe('OPEN');
    const placed = await agent.post('/api/bets').send(slip(mw, 20_00)).expect(201);
    expect(placed.body.data.status).toBe('PENDING_DELAY');
    expect(acceptJobs.at(-1)).toEqual({ betId: placed.body.data.id, delayMs: mw.betDelayMs });
    expect((await wallet(agent)).locked).toBe(20_00);

    const accepted = await acceptPendingBet(placed.body.data.id as string);
    expect(accepted?.status).toBe('ACCEPTED');
    expect((await wallet(agent)).locked).toBe(20_00);
  });

  it('rejects and refunds if a delivery happened during the delay', async () => {
    const { matchId } = await liveOpenMatch();
    const { agent } = await registerAgent(app());
    const placed = await agent.post('/api/bets').send(slip(await market(matchId, 'MATCH_WINNER'), 20_00)).expect(201);
    clock += 1000;
    await replayTick(clock); // the next ball lands inside the delay window
    const result = await acceptPendingBet(placed.body.data.id as string);
    expect(result).toMatchObject({ status: 'REJECTED', rejectReason: 'MARKET_SUSPENDED' });
    expect(await wallet(agent)).toMatchObject({ balance: WELCOME, locked: 0 });
    expect(await LedgerEntry.countDocuments({ idempotencyKey: `refund:${placed.body.data.id as string}` })).toBe(2);
    // Processing twice is a no-op.
    expect(await acceptPendingBet(placed.body.data.id as string)).toBeNull();
  });
});

describe('accumulators', () => {
  it('combines legs from different matches; same-match legs are refused', async () => {
    const a = await preMatch(0);
    const b = await preMatch(1);
    const { agent } = await registerAgent(app());
    const m1 = await market(a.matchId, 'MATCH_WINNER');
    const m2 = await market(b.matchId, 'MATCH_WINNER');
    const legs = [m1, m2].map((m) => ({ marketId: m._id.toString(), selectionId: m.selections[0]!.id, odds: m.selections[0]!.odds }));
    const res = await agent.post('/api/bets').send({ legs, stake: 10_00, idempotencyKey: randomUUID() }).expect(201);
    expect(res.body.data.kind).toBe('ACCA');
    expect(res.body.data.odds).toBe(Math.floor((legs[0]!.odds * legs[1]!.odds) / 100));

    const sameMatch = [m1, await market(a.matchId, 'INNINGS_TOTAL:1')].map((m) => ({ marketId: m._id.toString(), selectionId: m.selections[0]!.id, odds: m.selections[0]!.odds }));
    await agent.post('/api/bets').send({ legs: sameMatch, stake: 10_00, idempotencyKey: randomUUID() }).expect(400);
  });
});

describe('cash out', () => {
  it('quotes and cashes out an open Match Winner single exactly once', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const bet = (await agent.post('/api/bets').send(slip(await market(matchId, 'MATCH_WINNER'), 100_00)).expect(201)).body.data;
    const quote = (await agent.get(`/api/bets/${bet.id as string}/cashout-quote`).expect(200)).body.data;
    expect(quote.amount).toBeGreaterThan(0);
    expect(quote.amount).toBeLessThan(bet.potentialReturn);

    const done = await agent.post(`/api/bets/${bet.id as string}/cashout`).send({ quoteToken: quote.quoteToken }).expect(200);
    expect(done.body.data).toMatchObject({ status: 'CASHED_OUT', payout: quote.amount });
    const after = await wallet(agent);
    expect(after).toMatchObject({ locked: 0, balance: WELCOME - 100_00 + (quote.amount as number) });
    // A retry with the same quote is idempotent: same bet back, no second payout.
    const retry = await agent.post(`/api/bets/${bet.id as string}/cashout`).send({ quoteToken: quote.quoteToken }).expect(200);
    expect(retry.body.data).toMatchObject({ status: 'CASHED_OUT', payout: quote.amount });
    expect(await wallet(agent)).toEqual(after);
    expect(await LedgerEntry.countDocuments({ type: 'CASHOUT', refId: bet.id })).toBe(2);
    // A fresh quote for a cashed-out bet is refused.
    await agent.get(`/api/bets/${bet.id as string}/cashout-quote`).expect(422);
  });

  it('refuses tampered quotes and non-eligible markets', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const bet = (await agent.post('/api/bets').send(slip(await market(matchId, 'MATCH_WINNER'), 100_00)).expect(201)).body.data;
    const quote = (await agent.get(`/api/bets/${bet.id as string}/cashout-quote`).expect(200)).body.data;
    const [body, mac] = (quote.quoteToken as string).split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), amount: 999_999_00 })).toString('base64url')}.${mac!}`;
    await agent.post(`/api/bets/${bet.id as string}/cashout`).send({ quoteToken: forged }).expect(409);

    const totalBet = (await agent.post('/api/bets').send(slip(await market(matchId, 'INNINGS_TOTAL:1'), 10_00)).expect(201)).body.data;
    await agent.get(`/api/bets/${totalBet.id as string}/cashout-quote`).expect(422);
  });
});

describe('history, admin void and reconciliation', () => {
  it('lists own bets by bucket and hides other users’ bets', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    for (let i = 0; i < 3; i += 1) await agent.post('/api/bets').send(slip(mw, 10_00)).expect(201);
    const open = await agent.get('/api/bets?status=open&limit=2').expect(200);
    expect(open.body.data).toHaveLength(2);
    expect(open.body.meta.nextCursor).toBeTruthy();
    expect((await agent.get('/api/bets?status=settled').expect(200)).body.data).toHaveLength(0);
    const { agent: other } = await registerAgent(app());
    await other.get(`/api/bets/${open.body.data[0].id as string}`).expect(404);
  });

  it('admin voids an open bet with a reason: refund, audit, live feed', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    const bet = (await agent.post('/api/bets').send(slip(mw, 40_00)).expect(201)).body.data;
    const staff = await createStaff('admin');
    const admin = request.agent(app());
    await admin.post('/api/admin/auth/login').send({ email: staff.email, password: staff.password }).expect(200);
    const feed = await admin.get(`/api/admin/bets?matchId=${matchId}`).expect(200);
    expect(feed.body.data[0]).toMatchObject({ id: bet.id, ip: expect.any(String) });
    await admin.post(`/api/admin/bets/${bet.id as string}/void`).send({ reason: 'Placed on wrong market' }).expect(200);
    expect(await wallet(agent)).toMatchObject({ balance: WELCOME, locked: 0 });
    expect(await AuditLog.countDocuments({ action: 'bet.void', targetId: bet.id })).toBe(1);
    expect((await getBook(mw._id.toString(), mw.selections.map((s) => s.id))).totalStake).toBe(0);
  });

  it('reconciliation stays clean after betting, cash-outs and rejections', async () => {
    const { matchId } = await preMatch();
    const { agent } = await registerAgent(app());
    const mw = await market(matchId, 'MATCH_WINNER');
    await agent.post('/api/bets').send(slip(mw, 25_00)).expect(201);
    const b = (await agent.post('/api/bets').send(slip(mw, 25_00, 1)).expect(201)).body.data;
    const q = (await agent.get(`/api/bets/${b.id as string}/cashout-quote`).expect(200)).body.data;
    await agent.post(`/api/bets/${b.id as string}/cashout`).send({ quoteToken: q.quoteToken }).expect(200);
    const run = await runReconciliation('manual');
    expect(run.mismatches).toEqual([]);
    expect(run.status).toBe('clean');
  });
});
