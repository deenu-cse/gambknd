import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { STRONG_PASSWORD, createStaff, registerAgent, useTestApp } from '../../tests/helpers.js';
import { AuditLog } from '../audit/audit.model.js';
import { Bet, type IBet } from '../bets/bet.model.js';
import { addExposure } from '../markets/liability.js';
import { Market } from '../markets/market.model.js';
import { Match } from '../matches/match.model.js';
import { getSettings } from '../settings/settings.service.js';
import { User } from '../users/user.model.js';
import { availableAccount, lockedAccount } from '../wallet/accounts.js';
import { transfer } from '../wallet/ledger.service.js';
import { utcDayStart } from './admin.overview.service.js';

const { app } = useTestApp();

async function adminAgent(role: 'admin' | 'superadmin' = 'admin') {
  const staff = await createStaff(role);
  const agent = request.agent(app());
  const res = await agent.post('/api/admin/auth/login').send({ email: staff.email, password: STRONG_PASSWORD });
  expect(res.status).toBe(200);
  return { agent, ...staff };
}

const reason = { reason: 'Test reason for this action' };

async function seedBet(userId: string, over: Partial<IBet> & { stake: number; marketType?: string }): Promise<IBet> {
  const { marketType = 'MATCH_WINNER', ...rest } = over;
  const oid = rest.userId ?? (User.hydrate({ _id: userId }) as { _id: IBet['userId'] })._id;
  const now = new Date();
  const doc = await Bet.create({
    userId: oid, kind: 'SINGLE', odds: 200, potentialReturn: rest.stake * 2, status: 'LOST', idempotencyKey: randomUUID(), placedAt: now, settledAt: now, payout: 0,
    legs: [{ matchId: oid, marketId: oid, selectionId: 's1', marketType, marketName: 'M', selectionName: 'S', matchTitle: 'T', odds: 200, requestedOdds: 200, marketVersion: 1, inPlay: false }],
    ...rest,
  });
  return doc.toObject();
}

describe('admin access', () => {
  it('refuses a player, even with a valid user session', async () => {
    const { agent } = await registerAgent(app());
    expect((await agent.get('/api/admin/overview')).status).toBe(401);
    expect((await request(app()).get('/api/admin/users')).status).toBe(401);
  });

  it('records admin logins in the audit log', async () => {
    const { userId } = await adminAgent();
    expect(await AuditLog.countDocuments({ action: 'auth.admin_login', targetId: userId })).toBe(1);
  });
});

describe('admin users', () => {
  it('searches by name or email and joins the wallet', async () => {
    const { agent } = await adminAgent();
    const { email, userId } = await registerAgent(app(), { name: 'Findable Person' });
    await registerAgent(app(), { name: 'Someone Else' });

    const byName = await agent.get('/api/admin/users').query({ q: 'findable' });
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0]).toMatchObject({ id: userId, email, balance: 1_000_00, locked: 0 });

    expect((await agent.get('/api/admin/users').query({ q: email.toUpperCase() })).body.data[0].id).toBe(userId);
    expect((await agent.get('/api/admin/users').query({ q: userId })).body.data[0].id).toBe(userId);
    // Regex characters are matched literally, not interpreted.
    expect((await agent.get('/api/admin/users').query({ q: '.*' })).body.data).toHaveLength(0);
  });

  it('never exposes password hashes or TOTP secrets', async () => {
    const { agent } = await adminAgent();
    const { userId } = await registerAgent(app());
    const res = await agent.get(`/api/admin/users/${userId}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|secretEnc|\$argon2/);
    expect(res.body.data.stats).toMatchObject({ bets: 0, activeSessions: 1 });
  });

  it('suspend ends sessions at once and blocks login; unsuspend restores access', async () => {
    const { agent } = await adminAgent();
    const player = await registerAgent(app());
    expect((await player.agent.get('/api/wallet')).status).toBe(200);

    const res = await agent.post(`/api/admin/users/${player.userId}/suspend`).send(reason);
    expect(res.status).toBe(200);
    expect(res.body.data.user.status).toBe('suspended');
    expect(res.body.data.user.statusReason).toBe(reason.reason);

    expect((await player.agent.get('/api/wallet')).status).toBe(401);
    expect((await request(app()).post('/api/auth/login').send({ email: player.email, password: STRONG_PASSWORD })).body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await agent.post(`/api/admin/users/${player.userId}/suspend`).send(reason)).body.error.code).toBe('INVALID_STATE');

    const back = await agent.post(`/api/admin/users/${player.userId}/unsuspend`).send(reason);
    expect(back.body.data.user.status).toBe('active');
    expect((await request(app()).post('/api/auth/login').send({ email: player.email, password: STRONG_PASSWORD })).status).toBe(200);
    expect(await AuditLog.countDocuments({ action: { $in: ['user.suspend', 'user.unsuspend'] }, targetId: player.userId })).toBe(2);
  });

  it('a suspension never lifts a permanent self-exclusion', async () => {
    const { agent } = await adminAgent();
    const { userId } = await registerAgent(app());
    await User.updateOne({ _id: userId }, { $set: { status: 'self_excluded', 'responsiblePlay.selfExcludedUntil': null } });

    await agent.post(`/api/admin/users/${userId}/suspend`).send(reason).expect(200);
    const back = await agent.post(`/api/admin/users/${userId}/unsuspend`).send(reason);
    expect(back.body.data.user.status).toBe('self_excluded');
  });

  it('force logout revokes every session', async () => {
    const { agent } = await adminAgent();
    const player = await registerAgent(app());
    const res = await agent.post(`/api/admin/users/${player.userId}/force-logout`).send(reason);
    expect(res.body.data.revoked).toBe(1);
    expect((await player.agent.get('/api/wallet')).status).toBe(401);
    expect((await agent.get(`/api/admin/users/${player.userId}/sessions`)).body.data[0].revokeReason).toBe('admin_force');
  });

  it('reset limits clears limits but leaves a cool-off the player chose', async () => {
    const { agent } = await adminAgent();
    const { userId } = await registerAgent(app());
    const until = new Date(Date.now() + 3_600_000);
    await User.updateOne({ _id: userId }, { $set: { 'responsiblePlay.dailyStakeLimit': 500, 'responsiblePlay.dailyLossLimit': 100, 'responsiblePlay.cooldownUntil': until } });

    const res = await agent.post(`/api/admin/users/${userId}/reset-limits`).send(reason);
    expect(res.body.data.user.responsiblePlay).toMatchObject({ dailyStakeLimit: null, dailyLossLimit: null });
    expect(new Date(res.body.data.user.responsiblePlay.cooldownUntil as string).getTime()).toBe(until.getTime());
  });

  it('staff cannot manage peers or themselves; a superadmin can manage staff', async () => {
    const { agent, userId } = await adminAgent();
    const peer = await createStaff('admin');
    expect((await agent.post(`/api/admin/users/${peer.userId}/suspend`).send(reason)).status).toBe(403);
    expect((await agent.post(`/api/admin/users/${userId}/suspend`).send(reason)).body.error.code).toBe('SELF_ACTION_FORBIDDEN');

    const root = await adminAgent('superadmin');
    expect((await root.agent.post(`/api/admin/users/${peer.userId}/suspend`).send(reason)).status).toBe(200);
  });

  it('requires a reason', async () => {
    const { agent } = await adminAgent();
    const { userId } = await registerAgent(app());
    expect((await agent.post(`/api/admin/users/${userId}/suspend`).send({ reason: 'no' })).body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('admin overview', () => {
  it('reports KPIs from the ledger, not from wallets or bets alone', async () => {
    const { agent } = await adminAgent();
    const { userId } = await registerAgent(app());
    await registerAgent(app());
    // House takes 300, pays 120: net +180 today, whatever the bonuses were.
    await transfer({ from: availableAccount(userId), to: lockedAccount(userId), amount: 300, type: 'BET_STAKE', idempotencyKey: 'x-stake', ref: { type: 'bet', id: 'x' } });
    await transfer({ from: lockedAccount(userId), to: 'house', amount: 300, type: 'BET_STAKE_CAPTURE', idempotencyKey: 'x-capture', ref: { type: 'bet', id: 'x' } });
    await transfer({ from: 'house', to: availableAccount(userId), amount: 120, type: 'BET_PAYOUT', idempotencyKey: 'x-payout', ref: { type: 'bet', id: 'x' } });
    await seedBet(userId, { stake: 300, payout: 120, status: 'WON' });

    const { data } = (await agent.get('/api/admin/overview')).body;
    expect(data.users.total).toBe(2);
    expect(data.housePnl).toEqual({ today: 180, d7: 180, d30: 180 });
    expect(data.today).toEqual({ staked: 300, bets: 1 });
    // 2 welcome bonuses, minus the net 180 the house kept.
    expect(data.tokens.circulation).toBe(2 * 1_000_00 - 180);
  });

  it('excludes rejected bets from stakes, and fills empty days in the series', async () => {
    const { agent } = await adminAgent();
    const { userId } = await registerAgent(app());
    await seedBet(userId, { stake: 500, status: 'REJECTED', settledAt: null });
    await seedBet(userId, { stake: 200, status: 'LOST' });
    await seedBet(userId, { stake: 100, status: 'CASHED_OUT', payout: 60, marketType: 'TOSS_WINNER' });

    const { data } = (await agent.get('/api/admin/overview/charts').query({ days: 7 })).body;
    expect(data.betsOverTime).toHaveLength(7);
    expect(data.betsOverTime.at(-1)).toMatchObject({ date: utcDayStart(new Date()).toISOString().slice(0, 10), bets: 2, staked: 300 });
    expect(data.betsOverTime[0].bets).toBe(0);
    expect(data.pnlByMarketType).toEqual([
      { marketType: 'MATCH_WINNER', pnl: 200, staked: 200, bets: 1 },
      { marketType: 'TOSS_WINNER', pnl: 40, staked: 100, bets: 1 },
    ]);
  });
});

describe('admin risk', () => {
  it('reports worst-case loss per selection and flags players beating the prices', async () => {
    const { agent } = await adminAgent();
    const { userId } = await registerAgent(app());
    const fav = await registerAgent(app());
    const match = await Match.create({
      providerRef: { provider: 'replay', id: 'r1' }, source: 'replay', title: 'A v B', format: 'T20', teams: [{ key: 'a', name: 'A', shortName: 'A' }, { key: 'b', name: 'B', shortName: 'B' }],
      startTime: new Date(), status: 'UPCOMING', capabilities: { ballByBall: false, scorecard: false }, lastSyncedAt: new Date(),
    });
    const market = await Market.create({
      matchId: match._id, key: 'mw', type: 'MATCH_WINNER', group: 'MAIN', name: 'Match Winner', inPlay: false, marginBps: 500, betDelayMs: 0, minStake: 1, maxStake: 1000, maxLiability: 10_000, status: 'OPEN',
      selections: [{ id: 'a', name: 'A', odds: 200, probabilityBps: 5000 }, { id: 'b', name: 'B', odds: 200, probabilityBps: 5000 }],
    });
    await seedBet(userId, { stake: 400, potentialReturn: 800, status: 'ACCEPTED', settledAt: null, legs: [{ matchId: match._id, marketId: market._id, selectionId: 'a', marketType: 'MATCH_WINNER', marketName: 'Match Winner', selectionName: 'A', matchTitle: 'A v B', lineX10: null, odds: 200, requestedOdds: 200, marketVersion: 1, inPlay: false, result: 'PENDING', deadHeatWays: null }] });
    await addExposure(market._id.toString(), 'a', 400, 800);

    // 12/12 at evens is a run nobody expects; 12/12 on 1.05 favourites is nothing unusual.
    for (let i = 0; i < 12; i += 1) await seedBet(userId, { stake: 100, payout: 200, status: 'WON', odds: 200 });
    for (let i = 0; i < 12; i += 1) await seedBet(fav.userId, { stake: 100, payout: 105, status: 'WON', odds: 105 });

    const { data } = (await agent.get('/api/admin/risk')).body;
    expect(data.totalLiability).toBe(400);
    expect(data.markets[0]).toMatchObject({ marketName: 'Match Winner', worstCaseLoss: 400, totalStake: 400, utilizationBps: 400, matchTitle: 'A v B' });
    expect(data.markets[0].selections).toEqual([
      { id: 'a', name: 'A', odds: 200, worstCaseLoss: 400 },
      { id: 'b', name: 'B', odds: 200, worstCaseLoss: -400 },
    ]);
    expect(data.biggestBets[0].user.name).toBe('Test User');
    expect(data.unusualWinRates.map((u: { userId: string }) => u.userId)).toEqual([userId]);
    expect(data.unusualWinRates[0]).toMatchObject({ bets: 12, wins: 12, winRateBps: 10_000, expectedWinRateBps: 5000 });
  });
});

describe('admin ledger and audit search', () => {
  it('finds both legs of a transaction and pages by cursor', async () => {
    const { agent } = await adminAgent();
    const { userId } = await registerAgent(app());
    const legs = (await agent.get('/api/admin/ledger').query({ userId, type: 'WELCOME_BONUS' })).body.data;
    expect(legs).toHaveLength(1);
    const both = (await agent.get('/api/admin/ledger').query({ txnId: legs[0].txnId })).body.data;
    expect(both.map((l: { direction: string }) => l.direction).sort()).toEqual(['credit', 'debit']);

    const first = await agent.get('/api/admin/ledger').query({ limit: 1 });
    expect(first.body.data).toHaveLength(1);
    const next = await agent.get('/api/admin/ledger').query({ limit: 1, cursor: first.body.meta.nextCursor });
    expect(next.body.data[0].id).not.toBe(first.body.data[0].id);
  });

  it('filters the audit log and names the actor', async () => {
    const { agent, userId: adminId } = await adminAgent();
    const { userId } = await registerAgent(app());
    await agent.post(`/api/admin/users/${userId}/force-logout`).send(reason).expect(200);

    const res = await agent.get('/api/admin/audit').query({ action: 'user.force_logout' });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ actorId: adminId, targetId: userId, reason: reason.reason });
    expect(res.body.data[0].actor.name).toBe('admin person');
    expect((await agent.get('/api/admin/audit/filters')).body.data.actions).toContain('user.force_logout');
  });
});

describe('admin settings', () => {
  it('changes take effect, are audited, and record only what changed', async () => {
    const { agent } = await adminAgent();
    const res = await agent.patch('/api/admin/settings').send({ welcomeBonus: 500_00, dailyBonus: 100_00, reason: 'Lower the welcome bonus' });
    expect(res.status).toBe(200);
    expect(res.body.data.welcomeBonus).toBe(500_00);

    const { userId } = await registerAgent(app());
    expect((await agent.get(`/api/admin/users/${userId}/wallet`)).body.data.available).toBe(500_00);

    const log = await AuditLog.findOne({ action: 'settings.update' }).lean();
    expect(log?.before).toEqual({ welcomeBonus: 1_000_00 });
    expect(log?.after).toEqual({ welcomeBonus: 500_00 });
  });

  it('merges margins per type and rejects impossible stake ranges', async () => {
    const { agent } = await adminAgent();
    await agent.patch('/api/admin/settings').send({ defaultMarginsBps: { MATCH_WINNER: 700 }, reason: 'Widen the winner margin' }).expect(200);
    const s = await getSettings();
    expect(s.defaultMarginsBps.MATCH_WINNER).toBe(700);
    expect(s.defaultMarginsBps.TOSS_WINNER).toBe(500);

    expect((await agent.patch('/api/admin/settings').send({ globalMinStake: s.globalMaxStake + 1, reason: 'This should be refused' })).status).toBe(400);
    expect((await agent.patch('/api/admin/settings').send({ defaultMarginsBps: { NOPE: 1 }, reason: 'Unknown market type' })).status).toBe(400);
  });

  it('maintenance mode shows on the public status endpoint', async () => {
    const { agent } = await adminAgent();
    await agent.patch('/api/admin/settings').send({ maintenance: { enabled: true, message: 'Back soon' }, reason: 'Planned maintenance' }).expect(200);
    expect((await request(app()).get('/api/status')).body.data.maintenance).toEqual({ enabled: true, message: 'Back soon' });
  });
});

describe('admin system health', () => {
  it('reports dependencies, queues and the error rate', async () => {
    const { agent } = await adminAgent();
    const { data } = (await agent.get('/api/admin/system/health')).body;
    expect(data.dependencies.mongo.ok).toBe(true);
    expect(data.dependencies.redis.ok).toBe(true);
    expect(data.queues.map((q: { name: string }) => q.name)).toEqual(['maintenance', 'sync', 'markets', 'bets', 'settlement']);
    expect(data.errorRate.windowMinutes).toBe(15);
    expect(data.errorRate.requests).toBeGreaterThan(0);
  });

  it('audits the actions that used to go unrecorded', async () => {
    const { agent } = await adminAgent();
    await agent.post('/api/admin/reconciliation/run').send({}).expect(200);
    await agent.post('/api/admin/settlement/catch-up').send({}).expect(200);
    await agent.post('/api/admin/leaderboard/rebuild').send({}).expect(200);
    const actions = await AuditLog.distinct('action');
    expect(actions).toEqual(expect.arrayContaining(['reconciliation.run', 'settlement.catch_up', 'leaderboard.rebuild']));
  });
});
