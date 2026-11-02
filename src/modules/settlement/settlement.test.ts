import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getReplayStore } from '../../providers/cricket/index.js';
import { replayScripts } from '../../providers/cricket/replay/scripts.js';
import { createStaff, registerAgent, useTestApp } from '../../tests/helpers.js';
import { replayTick } from '../../workers/poller.js';
import { AuditLog } from '../audit/audit.model.js';
import { Bet } from '../bets/bet.model.js';
import { setAcceptanceScheduler } from '../bets/placement.service.js';
import { onMatchChange, setReopenScheduler } from '../markets/engine.js';
import { Market, type IMarket } from '../markets/market.model.js';
import { clearMatchChangeHandlers, registerMatchChangeHandler } from '../matches/matchEvents.js';
import { Match } from '../matches/match.model.js';
import { Notification } from '../notifications/notification.model.js';
import { DEFAULT_SETTINGS } from '../settings/settings.model.js';
import { LedgerEntry } from '../wallet/ledger.model.js';
import { runReconciliation } from '../wallet/reconciliation.service.js';
import { onMatchChangeSettle } from './settlement.handler.js';
import { autoSettleMatch, settleMarket } from './settlement.service.js';

const { app } = useTestApp();
const WELCOME = DEFAULT_SETTINGS.welcomeBonus;
const script = replayScripts().find((s) => s.id.startsWith('2nd-match'))!; // Sweden W beat Bulgaria W
const winner = script.result.winnerKey!;
const loser = script.teams.find((t) => t.key !== winner)!.key;

beforeAll(() => {
  registerMatchChangeHandler('markets', onMatchChange);
  registerMatchChangeHandler('settlement', onMatchChangeSettle); // inline settlement in tests
  setReopenScheduler(() => Promise.resolve());
  setAcceptanceScheduler(() => Promise.resolve());
});
afterAll(() => clearMatchChangeHandlers());

// Replay steps run on this simulated clock. Sessions start at clock + 1000 so each tick is exactly one step.
let clock = Date.now();
async function preMatch(scriptId = script.id) {
  clock = Date.now();
  const store = getReplayStore();
  const session = await store.create({ scriptId, intervalMs: 1000, startInSec: 3600, seed: 'test-seed' });
  await replayTick(clock);
  const match = (await Match.findOne({ 'providerRef.id': session.providerId }).lean())!;
  return { store, session, matchId: match._id.toString() };
}
async function finish(ctx: Awaited<ReturnType<typeof preMatch>>) {
  await ctx.store.control(ctx.session.id, 'start', clock + 1000);
  await ctx.store.control(ctx.session.id, 'finish', clock);
  clock += 1000;
  await replayTick(clock);
}
const market = async (matchId: string, key: string): Promise<IMarket> => (await Market.findOne({ matchId, key }).lean())!;
async function back(agent: request.Agent, m: IMarket, selectionId: string, stake: number) {
  const sel = m.selections.find((s) => s.id === selectionId)!;
  return (await agent.post('/api/bets').send({ marketId: m._id.toString(), selectionId, odds: sel.odds, stake, idempotencyKey: randomUUID() }).expect(201)).body.data as { id: string; potentialReturn: number };
}
const wallet = async (agent: request.Agent) => (await agent.get('/api/wallet').expect(200)).body.data as { balance: number; locked: number; available: number; lifetimeStaked: number; lifetimeWon: number; netPnl: number };

describe('register → bonus → bet → settle → payout', () => {
  it('pays winners, takes losers’ stakes, notifies and ranks them', async () => {
    const ctx = await preMatch();
    const { agent: alice, userId: aliceId } = await registerAgent(app(), { name: 'Alice' });
    const { agent: bob } = await registerAgent(app(), { name: 'Bob' });
    const mw = await market(ctx.matchId, 'MATCH_WINNER');
    const aBet = await back(alice, mw, winner, 100_00);
    await back(bob, mw, loser, 100_00);

    await finish(ctx);
    const settledMarket = await market(ctx.matchId, 'MATCH_WINNER');
    expect(settledMarket).toMatchObject({ status: 'SETTLED', result: { winningSelectionIds: [winner], isVoid: false } });
    expect(settledMarket.selections.find((s) => s.id === winner)?.status).toBe('WINNER');

    expect(await wallet(alice)).toMatchObject({ balance: WELCOME - 100_00 + aBet.potentialReturn, locked: 0, lifetimeStaked: 100_00, lifetimeWon: aBet.potentialReturn, netPnl: aBet.potentialReturn - 100_00 });
    expect(await wallet(bob)).toMatchObject({ balance: WELCOME - 100_00, locked: 0, netPnl: -100_00 });
    expect((await Bet.findById(aBet.id).lean())?.status).toBe('WON');
    expect(await LedgerEntry.countDocuments({ refId: aBet.id, type: { $in: ['BET_STAKE_CAPTURE', 'BET_PAYOUT'] } })).toBe(4);

    const notes = await alice.get('/api/notifications?unread=true').expect(200);
    expect(notes.body.data.some((n: { type: string; title: string }) => n.type === 'BET_SETTLED' && n.title === 'Bet won')).toBe(true);
    await alice.post('/api/notifications/read-all').set('X-Requested-With', 'fetch').expect(200);
    expect((await alice.get('/api/notifications').expect(200)).body.meta.unread).toBe(0);

    const board = await alice.get('/api/leaderboard?period=daily&metric=profit').expect(200);
    expect(board.body.data.rows[0]).toMatchObject({ userId: aliceId, name: 'Alice', netProfit: aBet.potentialReturn - 100_00, rank: 1 });
    expect(board.body.data.me).toMatchObject({ userId: aliceId, rank: 1 });
    expect(board.body.data.rows.at(-1).netProfit).toBe(-100_00);

    expect((await runReconciliation('manual')).status).toBe('clean');
  });

  it('settles every market type the match produced, and closes nothing unsettled', async () => {
    const ctx = await preMatch();
    await finish(ctx);
    const rows = await Market.find({ matchId: ctx.matchId }).lean();
    const unsettled = rows.filter((m) => m.status !== 'SETTLED' && m.status !== 'VOID');
    expect(unsettled.map((m) => m.key)).toEqual([]);
    expect(rows.find((m) => m.key === 'TOSS_WINNER')?.result?.winningSelectionIds).toEqual([script.toss.winnerKey]);
  });

  it('settles is idempotent: running it again pays nothing twice', async () => {
    const ctx = await preMatch();
    const { agent } = await registerAgent(app());
    const bet = await back(agent, await market(ctx.matchId, 'MATCH_WINNER'), winner, 50_00);
    await finish(ctx);
    const before = await wallet(agent);
    const mw = await market(ctx.matchId, 'MATCH_WINNER');
    await settleMarket(mw._id.toString(), mw.result!);
    await autoSettleMatch(ctx.matchId);
    expect(await wallet(agent)).toEqual(before);
    expect(await LedgerEntry.countDocuments({ refId: bet.id, type: 'BET_PAYOUT' })).toBe(2);
  });
});

describe('voids, accumulators and in-play settlement', () => {
  it('abandonment voids the match winner and refunds', async () => {
    const ctx = await preMatch();
    const { agent } = await registerAgent(app());
    const bet = await back(agent, await market(ctx.matchId, 'MATCH_WINNER'), winner, 100_00);
    await ctx.store.control(ctx.session.id, 'start', clock + 1000);
    await ctx.store.control(ctx.session.id, 'abandon', clock);
    clock += 1000;
    await replayTick(clock);
    expect((await market(ctx.matchId, 'MATCH_WINNER')).status).toBe('VOID');
    expect((await Bet.findById(bet.id).lean())?.status).toBe('VOID');
    expect(await wallet(agent)).toMatchObject({ balance: WELCOME, locked: 0, netPnl: 0 });
  });

  it('an accumulator waits for its last leg', async () => {
    const a = await preMatch();
    const otherScript = replayScripts().find((s) => s.id.startsWith('1st-match'))!;
    const b = await preMatch(otherScript.id);
    const { agent } = await registerAgent(app());
    const legs = await Promise.all(
      [
        [a.matchId, winner],
        [b.matchId, otherScript.result.winnerKey!],
      ].map(async ([matchId, sel]) => {
        const m = await market(matchId!, 'MATCH_WINNER');
        return { marketId: m._id.toString(), selectionId: sel!, odds: m.selections.find((s) => s.id === sel)!.odds };
      }),
    );
    const acca = (await agent.post('/api/bets').send({ legs, stake: 10_00, idempotencyKey: randomUUID() }).expect(201)).body.data;
    await finish(a);
    const half = (await Bet.findById(acca.id).lean())!;
    expect(half.status).toBe('ACCEPTED');
    expect(half.legs.map((l) => l.result)).toEqual(['WON', 'PENDING']);
    await finish(b);
    const done = (await Bet.findById(acca.id).lean())!;
    expect(done).toMatchObject({ status: 'WON', payout: acca.potentialReturn });
  });

  it('settles session markets mid-innings, as soon as the over is done', async () => {
    const ctx = await preMatch();
    const { agent } = await registerAgent(app());
    const session6 = await market(ctx.matchId, 'SESSION_RUNS:1:6');
    const bet = await back(agent, session6, 'yes', 20_00);
    await ctx.store.control(ctx.session.id, 'start', clock + 1000);
    for (let i = 0; i < 60 && ((await Match.findById(ctx.matchId).lean())?.innings[0]?.balls ?? 0) < 36; i += 1) {
      clock += 1000;
      await replayTick(clock);
    }
    const settled = await market(ctx.matchId, 'SESSION_RUNS:1:6');
    expect(['SETTLED', 'VOID']).toContain(settled.status);
    expect(['WON', 'LOST']).toContain((await Bet.findById(bet.id).lean())?.status);
    expect((await Match.findById(ctx.matchId).lean())?.status).toBe('LIVE'); // match still going
  });
});

describe('admin settlement tools', () => {
  async function admin() {
    const staff = await createStaff('admin');
    const agent = request.agent(app());
    await agent.post('/api/admin/auth/login').send({ email: staff.email, password: staff.password }).expect(200);
    return agent;
  }

  it('resettlement reverses the old result through the ledger and settles again', async () => {
    const ctx = await preMatch();
    const { agent: alice } = await registerAgent(app());
    const { agent: bob } = await registerAgent(app());
    const mw = await market(ctx.matchId, 'MATCH_WINNER');
    const aBet = await back(alice, mw, winner, 100_00);
    const bBet = await back(bob, mw, loser, 100_00);
    await finish(ctx);

    // Alice spends her winnings (admin clawback stands in for "spent"), so the reversal goes negative.
    const adm = await admin();
    const won = await wallet(alice);
    const aliceId = (await alice.get('/api/users/me').expect(200)).body.data.id as string;
    await adm.post(`/api/admin/users/${aliceId}/debit`).send({ amount: won.available, reason: 'simulate spending', idempotencyKey: randomUUID() }).expect(200);

    const res = await adm.post(`/api/admin/markets/${mw._id.toString()}/resettle`).send({ winningSelectionIds: [loser], reason: 'Official result corrected' }).expect(200);
    expect(res.body.data).toMatchObject({ betsReopened: 2, betsResettled: 2 });
    expect((await Bet.findById(aBet.id).lean())).toMatchObject({ status: 'LOST', settlementRound: 1 });
    expect((await Bet.findById(bBet.id).lean())).toMatchObject({ status: 'WON', payout: bBet.potentialReturn });
    const a = await wallet(alice);
    expect(a.available).toBe(-(aBet.potentialReturn)); // payout taken back after being spent
    expect(await wallet(bob)).toMatchObject({ balance: WELCOME - 100_00 + bBet.potentialReturn, locked: 0 });
    expect(await LedgerEntry.countDocuments({ refId: aBet.id, type: 'BET_RESETTLE_REVERSAL' })).toBe(4);
    expect(await AuditLog.countDocuments({ action: 'market.resettle' })).toBe(1);
    expect((await runReconciliation('manual')).status).toBe('clean');
    expect(await Notification.countDocuments({ type: 'BET_RESETTLED' })).toBe(2);
  });

  it('manual queue: unclear results wait for an admin, who settles them by hand', async () => {
    const ctx = await preMatch();
    const { agent } = await registerAgent(app());
    const bet = await back(agent, await market(ctx.matchId, 'MATCH_WINNER'), winner, 10_00);
    // Finish with settlement paused, then make the result text unmappable: the resolver must refuse to guess.
    clearMatchChangeHandlers();
    registerMatchChangeHandler('markets', onMatchChange);
    await finish(ctx);
    await Match.updateOne({ _id: ctx.matchId }, { $set: { 'result.confident': false, 'result.winnerKey': null } });
    await autoSettleMatch(ctx.matchId);
    registerMatchChangeHandler('settlement', onMatchChangeSettle);
    const mw = await market(ctx.matchId, 'MATCH_WINNER');
    expect(mw).toMatchObject({ status: 'CLOSED', result: null });
    expect((await Bet.findById(bet.id).lean())?.status).toBe('ACCEPTED'); // waiting for a human

    const adm = await admin();
    const queue = await adm.get('/api/admin/settlement/pending').expect(200);
    expect(queue.body.data.some((q: { market: { id: string } }) => q.market.id === mw._id.toString())).toBe(true);
    await adm.post(`/api/admin/markets/${mw._id.toString()}/settle`).send({ winningSelectionIds: [winner], reason: 'Checked the official scorecard' }).expect(200);
    expect((await Bet.findById(bet.id).lean())?.status).toBe('WON');
    await adm.post(`/api/admin/markets/${mw._id.toString()}/settle`).send({ winningSelectionIds: [winner], reason: 'twice' }).expect(422);
  });

  it('voids a market by hand with refunds', async () => {
    const ctx = await preMatch();
    const { agent } = await registerAgent(app());
    const total = await market(ctx.matchId, 'INNINGS_TOTAL:1');
    await back(agent, total, 'over', 30_00);
    const adm = await admin();
    await adm.post(`/api/admin/markets/${total._id.toString()}/void`).send({ reason: 'Pricing error on line' }).expect(200);
    expect(await wallet(agent)).toMatchObject({ balance: WELCOME, locked: 0 });
  });
});

describe('compare', () => {
  it('team head-to-head and player radar from our own data', async () => {
    const ctx = await preMatch();
    await finish(ctx);
    const teams = await request(app()).get(`/api/compare/teams?a=${winner}&b=${loser}`).expect(200);
    expect(teams.body.data.headToHead).toMatchObject({ played: 1, aWins: 1, bWins: 0 });
    expect(teams.body.data.a.recentForm[0]).toBe('W');
    expect(teams.body.data.b.batting.averageScore).toBeGreaterThan(0);

    const squads = (await request(app()).get(`/api/matches/${ctx.matchId}/squads`).expect(200)).body.data;
    const [p1, p2] = [squads[0].players[0].playerId, squads[1].players[0].playerId];
    const players = await request(app()).get(`/api/compare/players?a=${p1 as string}&b=${p2 as string}`).expect(200);
    expect(players.body.data.a.radar.battingAverage).toBeGreaterThanOrEqual(0);
    expect(players.body.data.a.player.id).toBe(p1);
  });
});
