import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.string().default('loopback'),

  MONGO_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// URI'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// URI'),

  CORS_ORIGINS: csv.default('http://localhost:3000,http://localhost:3001'),
  USER_APP_URL: z.string().url().default('http://localhost:3000'),
  ADMIN_APP_URL: z.string().url().default('http://localhost:3001'),

  JWT_ACCESS_SECRET: z.string().min(32, 'use at least 32 random characters'),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(14),
  ADMIN_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  REFRESH_REUSE_GRACE_SEC: z.coerce.number().int().min(0).max(60).default(10),
  COOKIE_SECURE: bool.default('true'),
  COOKIE_DOMAIN: z.string().optional(),

  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),

  GOOGLE_CLIENT_ID: z.string().optional(),
  // 32 bytes hex — encrypts admin TOTP secrets at rest
  TOTP_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex chars (32 bytes)'),

  // ── Cricket data provider (docs/API_CONTRACT.md) ──
  CRICKET_PROVIDER: z.enum(['live', 'replay']).default('replay'),
  CRICAPI_KEY: z.string().optional(),
  CRICAPI_BASE_URL: z.string().url().default('https://api.cricapi.com/v1'),
  CRICAPI_DAILY_HIT_LIMIT: z.coerce.number().int().min(1).default(100),
  CRICAPI_RESERVED_HITS: z.coerce.number().int().min(0).default(15),
  CRICAPI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),
  CRICAPI_BBB_ENABLED: bool.default('true'),
  CRICAPI_SCORECARD_ENABLED: bool.default('true'),
  POLLER_TICK_MS: z.coerce.number().int().min(500).default(2000),
  LIVE_POLL_MIN_MS: z.coerce.number().int().min(1000).default(4000),
  UPCOMING_POLL_MS: z.coerce.number().int().min(10_000).default(300_000),
  FIXTURE_SYNC_MS: z.coerce.number().int().min(60_000).default(6 * 3600 * 1000),
  // 20s per ball: long enough that 4s in-play bet delays aren't overtaken by the next delivery.
  REPLAY_BALL_INTERVAL_MS: z.coerce.number().int().min(250).default(20_000),

  // Only `npm run seed` reads these.
  SUPERADMIN_EMAIL: z.string().optional(),
  SUPERADMIN_PASSWORD: z.string().optional(),
  SEED_PASSWORD: z.string().optional(),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Gamb <no-reply@gamb.local>'),
  MAIL_OUTBOX_DIR: z.string().default('.data/mail'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Logger depends on env, so report config errors directly. Only keys are printed, never values.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    process.stderr.write(`Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
