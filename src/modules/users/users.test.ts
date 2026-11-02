import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerAgent, STRONG_PASSWORD, useTestApp } from '../../tests/helpers.js';

const { app } = useTestApp();

describe('profile & preferences', () => {
  it('updates name and preferences', async () => {
    const { agent } = await registerAgent(app());
    const res = await agent.patch('/api/users/me').send({ name: 'Renamed' }).expect(200);
    expect(res.body.data.name).toBe('Renamed');
    const prefs = await agent.patch('/api/users/me/preferences').send({ oddsFormat: 'fractional', acceptBetterOdds: false }).expect(200);
    expect(prefs.body.data.preferences).toEqual({ oddsFormat: 'fractional', acceptBetterOdds: false, theme: 'dark' });
  });

  it('rejects unknown fields and role escalation', async () => {
    const { agent } = await registerAgent(app());
    const res = await agent.patch('/api/users/me').send({ role: 'superadmin' });
    expect(res.status).toBe(400);
    const me = await agent.get('/api/users/me').expect(200);
    expect(me.body.data.role).toBe('user');
  });

  it('requires https avatars', async () => {
    const { agent } = await registerAgent(app());
    await agent.patch('/api/users/me').send({ avatar: 'javascript:alert(1)' }).expect(400);
    await agent.patch('/api/users/me').send({ avatar: 'https://example.com/a.png' }).expect(200);
  });
});

describe('responsible play', () => {
  it('tightens limits immediately and defers loosening by 24h', async () => {
    const { agent } = await registerAgent(app());
    const set = await agent
      .put('/api/users/me/responsible-play')
      .send({ dailyStakeLimit: 50_000, dailyLossLimit: 20_000, sessionReminderMinutes: 60 })
      .expect(200);
    expect(set.body.data.responsiblePlay).toMatchObject({ dailyStakeLimit: 50_000, dailyLossLimit: 20_000, pendingIncrease: null });

    const raise = await agent
      .put('/api/users/me/responsible-play')
      .send({ dailyStakeLimit: 100_000, dailyLossLimit: 20_000, sessionReminderMinutes: 60 })
      .expect(200);
    const rp = raise.body.data.responsiblePlay;
    expect(rp.dailyStakeLimit).toBe(50_000);
    expect(rp.pendingIncrease.dailyStakeLimit).toBe(100_000);
    expect(new Date(rp.pendingIncrease.effectiveAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
  });

  it('rejects fractional token amounts (integers only)', async () => {
    const { agent } = await registerAgent(app());
    await agent
      .put('/api/users/me/responsible-play')
      .send({ dailyStakeLimit: 100.5, dailyLossLimit: null, sessionReminderMinutes: null })
      .expect(400);
  });

  it('lets a break be extended but never shortened', async () => {
    const { agent } = await registerAgent(app());
    await agent.post('/api/users/me/break').send({ duration: '7d' }).expect(200);
    const shorter = await agent.post('/api/users/me/break').send({ duration: '24h' });
    expect(shorter.status).toBe(422);
    await agent.post('/api/users/me/break').send({ duration: '30d' }).expect(200);
  });

  it('self-exclusion requires explicit confirmation', async () => {
    const { agent } = await registerAgent(app());
    await agent.post('/api/users/me/self-exclude').send({ duration: '6m' }).expect(400);
    const res = await agent.post('/api/users/me/self-exclude').send({ duration: '6m', confirm: true }).expect(200);
    expect(res.body.data.status).toBe('self_excluded');
  });
});

describe('change password', () => {
  it('requires the current password and signs out other devices only', async () => {
    const { agent, email } = await registerAgent(app());
    const other = request.agent(app());
    await other.post('/api/auth/login').send({ email, password: STRONG_PASSWORD }).expect(200);

    await agent.post('/api/users/me/password').send({ currentPassword: 'Wrong$Pass123', newPassword: 'An0ther$Strong1' }).expect(401);
    await agent.post('/api/users/me/password').send({ currentPassword: STRONG_PASSWORD, newPassword: 'An0ther$Strong1' }).expect(200);

    await agent.get('/api/users/me').expect(200);
    await other.get('/api/users/me').expect(401);
  });
});
