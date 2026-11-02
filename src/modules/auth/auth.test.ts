import request from 'supertest';
import { authenticator } from 'otplib';
import { afterEach, describe, expect, it } from 'vitest';
import { cookieNames, createStaff, extractCookie, registerAgent, STRONG_PASSWORD, tokenFromOutbox, uniqueEmail, useTestApp } from '../../tests/helpers.js';
import { User } from '../users/user.model.js';
import { Session } from './session.model.js';
import { setGoogleVerifier, type GoogleIdentity } from './google.js';

const { app } = useTestApp();
const XHR = { 'X-Requested-With': 'fetch' };

function fakeGoogle(identity: Partial<GoogleIdentity> & { sub: string; email: string }): void {
  setGoogleVerifier({
    verify: (token) =>
      token === 'valid-google-id-token-xxxxxxxx'
        ? Promise.resolve({ emailVerified: true, name: 'G User', picture: null, ...identity })
        : Promise.reject(new Error('bad token')),
  });
}

describe('registration', () => {
  it('creates the account, sets httpOnly cookies and never returns secrets', async () => {
    const email = uniqueEmail();
    const res = await request(app())
      .post('/api/auth/register')
      .send({ name: 'Asha', email, password: STRONG_PASSWORD, acceptTerms: true });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ email, role: 'user', status: 'active', emailVerified: false, hasPassword: true });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|accessToken|refreshToken/);
    expect(cookieNames(res)).toEqual(expect.arrayContaining(['gamb_at', 'gamb_rt']));
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('rejects duplicate emails (case-insensitive)', async () => {
    const { email } = await registerAgent(app());
    const res = await request(app())
      .post('/api/auth/register')
      .send({ name: 'Dup', email: email.toUpperCase(), password: STRONG_PASSWORD, acceptTerms: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('enforces password strength with field-level details', async () => {
    const res = await request(app())
      .post('/api/auth/register')
      .send({ name: 'Weak', email: uniqueEmail(), password: 'password', acceptTerms: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d: { path: string }) => d.path === 'password')).toBe(true);
  });

  it('requires accepting the play-token terms', async () => {
    const res = await request(app())
      .post('/api/auth/register')
      .send({ name: 'NoTerms', email: uniqueEmail(), password: STRONG_PASSWORD, acceptTerms: false });
    expect(res.status).toBe(400);
  });

  it('verifies the email from the emailed link', async () => {
    const { agent, email } = await registerAgent(app());
    const token = tokenFromOutbox(email);
    await agent.post('/api/auth/verify-email').send({ token }).expect(200);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.data.emailVerified).toBe(true);
    // Single use.
    await agent.post('/api/auth/verify-email').send({ token }).expect(400);
  });
});

describe('login & lockout', () => {
  it('logs in with correct credentials', async () => {
    const { email } = await registerAgent(app());
    const res = await request(app()).post('/api/auth/login').send({ email, password: STRONG_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email);
  });

  it('returns the same error for unknown email and wrong password', async () => {
    const { email } = await registerAgent(app());
    const wrong = await request(app()).post('/api/auth/login').send({ email, password: 'Wrong$Pass123' });
    const unknown = await request(app()).post('/api/auth/login').send({ email: uniqueEmail(), password: 'Wrong$Pass123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const { email } = await registerAgent(app());
    for (let i = 0; i < 4; i += 1) {
      await request(app()).post('/api/auth/login').send({ email, password: 'Wrong$Pass123' }).expect(401);
    }
    const fifth = await request(app()).post('/api/auth/login').send({ email, password: 'Wrong$Pass123' });
    expect(fifth.status).toBe(423);
    const correct = await request(app()).post('/api/auth/login').send({ email, password: STRONG_PASSWORD });
    expect(correct.status).toBe(423);
    expect(correct.body.error.details.retryAfterSec).toBeGreaterThan(0);
  });

  it('rejects NoSQL operator injection in credentials', async () => {
    const res = await request(app()).post('/api/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
  });

  it('blocks suspended accounts', async () => {
    const { email, userId } = await registerAgent(app());
    await User.updateOne({ _id: userId }, { status: 'suspended' });
    const res = await request(app()).post('/api/auth/login').send({ email, password: STRONG_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('refresh rotation & sessions', () => {
  it('rotates the refresh token and detects reuse by revoking the family', async () => {
    const agent = request.agent(app());
    const reg = await agent
      .post('/api/auth/register')
      .send({ name: 'Rotor', email: uniqueEmail(), password: STRONG_PASSWORD, acceptTerms: true })
      .expect(201);
    const originalRt = extractCookie(reg, 'gamb_rt');

    const first = await agent.post('/api/auth/refresh').set(XHR).expect(200);
    expect(extractCookie(first, 'gamb_rt')).not.toBe(originalRt);
    // The jar now holds the rotated token, so refreshing again works.
    await agent.post('/api/auth/refresh').set(XHR).expect(200);

    // Replaying the original, already-rotated token is reuse: the whole session is revoked.
    const replay = await request(app()).post('/api/auth/refresh').set(XHR).set('Cookie', originalRt);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    await agent.post('/api/auth/refresh').set(XHR).expect(401);
    expect(await Session.countDocuments({ revokeReason: 'reuse_detected' })).toBe(1);
  });

  it('logout kills the access token immediately, not after 15 minutes', async () => {
    const agent = request.agent(app());
    const email = uniqueEmail();
    await agent.post('/api/auth/register').send({ name: 'Leaver', email, password: STRONG_PASSWORD, acceptTerms: true }).expect(201);
    const login = await agent.post('/api/auth/login').send({ email, password: STRONG_PASSWORD }).expect(200);
    const accessCookie = extractCookie(login, 'gamb_at');
    await request(app()).get('/api/auth/me').set('Cookie', accessCookie).expect(200);

    await agent.post('/api/auth/logout').set(XHR).expect(200);
    const res = await request(app()).get('/api/auth/me').set('Cookie', accessCookie);
    expect(res.status).toBe(401);
  });

  it('lists sessions and logs out all devices', async () => {
    const { agent, email } = await registerAgent(app());
    const second = request.agent(app());
    await second.post('/api/auth/login').send({ email, password: STRONG_PASSWORD }).expect(200);
    const list = await agent.get('/api/users/me/sessions').expect(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    await agent.post('/api/auth/logout-all').set(XHR).expect(200);
    await second.get('/api/auth/me').expect(401);
  });

  it('revokes a single other session from the profile', async () => {
    const { agent, email } = await registerAgent(app());
    const other = request.agent(app());
    await other.post('/api/auth/login').send({ email, password: STRONG_PASSWORD }).expect(200);
    const list = await agent.get('/api/users/me/sessions').expect(200);
    const target = list.body.data.find((s: { current: boolean }) => !s.current) as { id: string };
    await agent.delete(`/api/users/me/sessions/${target.id}`).set(XHR).expect(200);
    await other.get('/api/auth/me').expect(401);
    await agent.get('/api/auth/me').expect(200);
  });
});

describe('password reset', () => {
  it('resets via emailed token and signs out every session', async () => {
    const { agent, email } = await registerAgent(app());
    await request(app()).post('/api/auth/forgot-password').send({ email }).expect(200);
    const token = tokenFromOutbox(email);
    const newPassword = 'N3w$tronger-Pass';
    await request(app()).post('/api/auth/reset-password').send({ token, password: newPassword }).expect(200);

    await agent.get('/api/auth/me').expect(401);
    await request(app()).post('/api/auth/login').send({ email, password: STRONG_PASSWORD }).expect(401);
    await request(app()).post('/api/auth/login').send({ email, password: newPassword }).expect(200);
  });

  it('does not reveal whether an email exists', async () => {
    const res = await request(app()).post('/api/auth/forgot-password').send({ email: uniqueEmail() });
    expect(res.status).toBe(200);
  });
});

describe('google sign-in', () => {
  afterEach(() => setGoogleVerifier(null));

  it('is unavailable when not configured', async () => {
    setGoogleVerifier(null);
    const res = await request(app()).post('/api/auth/google').send({ idToken: 'valid-google-id-token-xxxxxxxx' });
    expect(res.status).toBe(503);
  });

  it('creates a passwordless account, then reuses it', async () => {
    const email = uniqueEmail('g');
    fakeGoogle({ sub: 'google-sub-1', email });
    const first = await request(app()).post('/api/auth/google').send({ idToken: 'valid-google-id-token-xxxxxxxx' });
    expect(first.status).toBe(200);
    expect(first.body.data.user).toMatchObject({ email, googleLinked: true, hasPassword: false, emailVerified: true });
    const again = await request(app()).post('/api/auth/google').send({ idToken: 'valid-google-id-token-xxxxxxxx' });
    expect(again.body.data.user.id).toBe(first.body.data.user.id);
  });

  it('links to an existing email account only when Google verified the email', async () => {
    const { email, userId } = await registerAgent(app());
    fakeGoogle({ sub: 'google-sub-2', email, emailVerified: false });
    const refused = await request(app()).post('/api/auth/google').send({ idToken: 'valid-google-id-token-xxxxxxxx' });
    expect(refused.status).toBe(401);

    fakeGoogle({ sub: 'google-sub-2', email, emailVerified: true });
    const linked = await request(app()).post('/api/auth/google').send({ idToken: 'valid-google-id-token-xxxxxxxx' });
    expect(linked.status).toBe(200);
    expect(linked.body.data.user).toMatchObject({ id: userId, googleLinked: true, hasPassword: true });
  });

  it('rejects a bad Google token', async () => {
    fakeGoogle({ sub: 'x', email: uniqueEmail() });
    const res = await request(app()).post('/api/auth/google').send({ idToken: 'forged-token-forged-token-xx' });
    expect(res.status).toBe(401);
  });
});

describe('admin realm', () => {
  it('refuses regular users on the admin login', async () => {
    const { email } = await registerAgent(app());
    const res = await request(app()).post('/api/admin/auth/login').send({ email, password: STRONG_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('uses separate cookies, and tokens do not cross realms', async () => {
    const staff = await createStaff('admin');
    const admin = request.agent(app());
    const res = await admin.post('/api/admin/auth/login').send({ email: staff.email, password: staff.password });
    expect(res.status).toBe(200);
    expect(cookieNames(res)).toEqual(expect.arrayContaining(['gadm_at', 'gadm_rt']));
    await admin.get('/api/admin/auth/me').expect(200);
    // An admin-realm token is not a user-realm token.
    await admin.get('/api/users/me').expect(401);

    const { agent: user } = await registerAgent(app());
    await user.get('/api/admin/auth/me').expect(401);
  });

  it('supports TOTP two-factor login', async () => {
    const staff = await createStaff('superadmin');
    const admin = request.agent(app());
    await admin.post('/api/admin/auth/login').send({ email: staff.email, password: staff.password }).expect(200);

    const setup = await admin.post('/api/admin/auth/totp/setup').set(XHR).expect(200);
    const secret = setup.body.data.secret as string;
    expect(setup.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const valid = authenticator.generate(secret);
    await admin.post('/api/admin/auth/totp/enable').send({ code: valid === '000000' ? '111111' : '000000' }).expect(401);
    await admin.post('/api/admin/auth/totp/enable').send({ code: valid }).expect(200);

    const noCode = await request(app()).post('/api/admin/auth/login').send({ email: staff.email, password: staff.password });
    expect(noCode.body.error.code).toBe('TOTP_REQUIRED');
    const withCode = await request(app())
      .post('/api/admin/auth/login')
      .send({ email: staff.email, password: staff.password, totpCode: authenticator.generate(secret) });
    expect(withCode.status).toBe(200);
  });
});

describe('request hardening', () => {
  it('rejects form-encoded mutations (CSRF)', async () => {
    const res = await request(app()).post('/api/auth/login').type('form').send('email=a@b.co&password=x');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('rejects bodiless mutations without the XHR header', async () => {
    const { agent } = await registerAgent(app());
    const res = await agent.post('/api/auth/logout');
    expect(res.status).toBe(403);
  });

  it('returns the error envelope for unknown routes', async () => {
    const res = await request(app()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, data: null, error: { code: 'NOT_FOUND' } });
    expect(res.body.meta.requestId).toBeTruthy();
  });

  it('rejects disallowed CORS origins', async () => {
    const res = await request(app()).get('/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    const ok = await request(app()).get('/health').set('Origin', 'http://localhost:3000');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});
