import { inject } from 'vitest';

// Runs before each test file imports app code, so config/env.ts parses these values.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = inject('mongoUri');
process.env.REDIS_URL = inject('redisUrl');
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.TOTP_ENC_KEY = 'a'.repeat(64);
// supertest talks plain http, and its cookie jar won't send Secure cookies over http.
process.env.COOKIE_SECURE = 'false';
process.env.REFRESH_REUSE_GRACE_SEC = '0';
process.env.LOGIN_MAX_FAILURES = '5';
process.env.GOOGLE_CLIENT_ID = '';
process.env.SMTP_URL = '';
