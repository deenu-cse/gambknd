import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createApp } from '../app.js';
import { connectMongo } from '../config/db.js';
import { env } from '../config/env.js';
import { closeRedis, getRedis } from '../config/redis.js';
import { hashPassword } from '../modules/auth/password.js';
import { User, type UserRole } from '../modules/users/user.model.js';
import { testOutbox } from '../utils/mailer.js';
import { invalidateSettingsCache } from '../modules/settings/settings.service.js';

export const STRONG_PASSWORD = 'Sup3r$ecretPass';

/** Connects Mongo/Redis for a test file and wipes all state between tests. */
export function useTestApp(): { app: () => Express } {
  let app: Express | undefined;
  beforeAll(async () => {
    await connectMongo(env.MONGO_URI);
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
    app = createApp();
  });
  afterEach(async () => {
    const collections = await mongoose.connection.db?.collections();
    await Promise.all((collections ?? []).map((c) => c.deleteMany({})));
    await getRedis().flushdb();
    testOutbox.length = 0;
    invalidateSettingsCache();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await closeRedis();
  });
  return {
    app: () => {
      if (!app) throw new Error('app not ready');
      return app;
    },
  };
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}${counter}_${Date.now()}@example.com`;
}

export async function registerAgent(app: Express, overrides: Partial<{ name: string; email: string; password: string }> = {}) {
  const agent = request.agent(app);
  const email = overrides.email ?? uniqueEmail();
  const res = await agent
    .post('/api/auth/register')
    .send({ name: overrides.name ?? 'Test User', email, password: overrides.password ?? STRONG_PASSWORD, acceptTerms: true });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email, userId: (res.body as { data: { user: { id: string } } }).data.user.id };
}

/** Creates a staff user directly in the DB (there is no public admin signup). */
export async function createStaff(role: UserRole = 'admin', password = STRONG_PASSWORD) {
  const email = uniqueEmail(role);
  const user = await User.create({ name: `${role} person`, email, passwordHash: await hashPassword(password), role, emailVerified: true });
  return { email, password, userId: user._id.toString() };
}

/** Pulls the `token` query param out of the most recent email sent to `to`. */
export function tokenFromOutbox(to: string): string {
  const mail = [...testOutbox].reverse().find((m) => m.to === to);
  const match = mail?.text.match(/token=([A-Za-z0-9_\-%]+)/);
  if (!match?.[1]) throw new Error(`no token mail for ${to}`);
  return decodeURIComponent(match[1]);
}

export function cookieNames(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((c) => c.split('=')[0] ?? '');
}

/** "name=value" for a cookie set by this response, ready for a `Cookie` header. */
export function extractCookie(res: request.Response, name: string): string {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const found = raw.find((c) => c.startsWith(`${name}=`));
  if (!found) throw new Error(`cookie ${name} not set`);
  return found.split(';')[0] ?? '';
}
