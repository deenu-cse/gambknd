import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createStaff, registerAgent, useTestApp } from '../../tests/helpers.js';
import { AuditLog } from '../audit/audit.model.js';
import { DEFAULT_SETTINGS } from '../settings/settings.model.js';
import { updateSettings } from '../settings/settings.service.js';
import { Wallet } from './wallet.model.js';

const { app } = useTestApp();
const WELCOME = DEFAULT_SETTINGS.welcomeBonus;
const DAILY = DEFAULT_SETTINGS.dailyBonus;

async function adminAgent(role: 'admin' | 'superadmin' = 'admin') {
  const staff = await createStaff(role);
  const agent = request.agent(app());
  await agent.post('/api/admin/auth/login').send({ email: staff.email, password: staff.password }).expect(200);
  return { agent, ...staff };
}

describe('user wallet', () => {
  it('registration credits the welcome bonus', async () => {
    const { agent } = await registerAgent(app());
    const res = await agent.get('/api/wallet').expect(200);
    expect(res.body.data).toMatchObject({
      unitsPerToken: 100,
      balance: WELCOME,
      locked: 0,
      available: WELCOME,
      lifetimeStaked: 0,
      lifetimeWon: 0,
      netPnl: 0,
      dailyBonus: { amount: DAILY, available: true, nextAvailableAt: null },
    });
  });

  it('respects a configured welcome bonus amount', async () => {
    await updateSettings({ welcomeBonus: 250_00 }, 'test');
    const { agent } = await registerAgent(app());
    const res = await agent.get('/api/wallet').expect(200);
    expect(res.body.data.balance).toBe(250_00);
  });

  it('daily bonus can be claimed once per 24h', async () => {
    const { agent } = await registerAgent(app());
    const first = await agent.post('/api/wallet/daily-bonus').set('X-Requested-With', 'fetch').expect(200);
    expect(first.body.data.balance).toBe(WELCOME + DAILY);
    expect(first.body.data.dailyBonus.available).toBe(false);
    expect(new Date(first.body.data.dailyBonus.nextAvailableAt).getTime()).toBeGreaterThan(Date.now() + 23.9 * 3600 * 1000);

    const second = await agent.post('/api/wallet/daily-bonus').set('X-Requested-With', 'fetch');
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('BONUS_NOT_AVAILABLE');
  });

  it('concurrent daily-bonus claims pay exactly once', async () => {
    const { agent, userId } = await registerAgent(app());
    await Promise.allSettled(Array.from({ length: 10 }, () => agent.post('/api/wallet/daily-bonus').set('X-Requested-With', 'fetch')));
    const wallet = await Wallet.findOne({ userId }).lean();
    expect(wallet?.balance).toBe(WELCOME + DAILY);
  });

  it('a user on a break cannot claim bonuses', async () => {
    const { agent } = await registerAgent(app());
    await agent.post('/api/users/me/break').send({ duration: '24h' }).expect(200);
    const res = await agent.post('/api/wallet/daily-bonus').set('X-Requested-With', 'fetch');
    expect(res.body.error.code).toBe('ACCOUNT_IN_COOLDOWN');
  });

  it('lists ledger transactions with filters and cursor pagination', async () => {
    const { agent } = await registerAgent(app());
    await agent.post('/api/wallet/daily-bonus').set('X-Requested-With', 'fetch').expect(200);

    const all = await agent.get('/api/wallet/transactions?limit=1').expect(200);
    expect(all.body.data).toHaveLength(1);
    expect(all.body.data[0]).toMatchObject({ type: 'DAILY_BONUS', bucket: 'available', signedAmount: DAILY, balanceAfter: WELCOME + DAILY });
    expect(all.body.meta.nextCursor).toBeTruthy();

    const next = await agent.get(`/api/wallet/transactions?limit=1&cursor=${all.body.meta.nextCursor as string}`).expect(200);
    expect(next.body.data[0].type).toBe('WELCOME_BONUS');
    expect(next.body.meta.nextCursor).toBeNull();

    const filtered = await agent.get('/api/wallet/transactions?type=WELCOME_BONUS').expect(200);
    expect(filtered.body.data.map((t: { type: string }) => t.type)).toEqual(['WELCOME_BONUS']);
    await agent.get('/api/wallet/transactions?type=CASH_WITHDRAWAL').expect(400);
  });

  it('only ever shows the caller their own wallet', async () => {
    await registerAgent(app());
    const res = await request(app()).get('/api/wallet');
    expect(res.status).toBe(401);
  });
});

describe('admin adjustments', () => {
  it('credits with a reason and writes an audit record', async () => {
    const admin = await adminAgent();
    const { userId } = await registerAgent(app());
    const res = await admin.agent
      .post(`/api/admin/users/${userId}/credit`)
      .send({ amount: 500_00, reason: 'Tournament prize', idempotencyKey: randomUUID() })
      .expect(200);
    expect(res.body.data.balance).toBe(WELCOME + 500_00);

    const audit = await AuditLog.findOne({ action: 'wallet.admin_credit' }).lean();
    expect(audit).toMatchObject({ targetId: userId, reason: 'Tournament prize', actorRole: 'admin' });
    expect(audit?.actorId?.toString()).toBe(admin.userId);
  });

  it('is idempotent per admin-supplied key', async () => {
    const admin = await adminAgent();
    const { userId } = await registerAgent(app());
    const body = { amount: 100_00, reason: 'Goodwill credit', idempotencyKey: randomUUID() };
    await admin.agent.post(`/api/admin/users/${userId}/credit`).send(body).expect(200);
    const again = await admin.agent.post(`/api/admin/users/${userId}/credit`).send(body).expect(200);
    expect(again.body.data.balance).toBe(WELCOME + 100_00);
    expect(await AuditLog.countDocuments({ action: 'wallet.admin_credit' })).toBe(1);
  });

  it('requires a reason', async () => {
    const admin = await adminAgent();
    const { userId } = await registerAgent(app());
    await admin.agent.post(`/api/admin/users/${userId}/credit`).send({ amount: 100, idempotencyKey: randomUUID() }).expect(400);
  });

  it('forbids crediting yourself', async () => {
    const admin = await adminAgent('superadmin');
    await Wallet.create({ userId: admin.userId });
    const res = await admin.agent
      .post(`/api/admin/users/${admin.userId}/credit`)
      .send({ amount: 100_00, reason: 'Paying myself', idempotencyKey: randomUUID() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SELF_ACTION_FORBIDDEN');
  });

  it('cannot debit more than the available balance', async () => {
    const admin = await adminAgent();
    const { userId } = await registerAgent(app());
    const res = await admin.agent
      .post(`/api/admin/users/${userId}/debit`)
      .send({ amount: WELCOME + 1, reason: 'Abuse clawback', idempotencyKey: randomUUID() });
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('caps a single adjustment', async () => {
    const admin = await adminAgent();
    const { userId } = await registerAgent(app());
    const res = await admin.agent
      .post(`/api/admin/users/${userId}/credit`)
      .send({ amount: DEFAULT_SETTINGS.adminMaxAdjustment + 1, reason: 'Too generous', idempotencyKey: randomUUID() });
    expect(res.status).toBe(422);
  });

  it('is closed to regular users', async () => {
    const { agent, userId } = await registerAgent(app());
    await agent.post(`/api/admin/users/${userId}/credit`).send({ amount: 1, reason: 'self service', idempotencyKey: randomUUID() }).expect(401);
  });

  it('runs reconciliation on demand', async () => {
    const admin = await adminAgent();
    await registerAgent(app());
    const res = await admin.agent.post('/api/admin/reconciliation/run').set('X-Requested-With', 'fetch').expect(200);
    expect(res.body.data).toMatchObject({ status: 'clean', walletsChecked: 1, trigger: 'manual' });
    const runs = await admin.agent.get('/api/admin/reconciliation/runs').expect(200);
    expect(runs.body.data).toHaveLength(1);
  });
});
