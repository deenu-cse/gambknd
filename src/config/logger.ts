import { pino } from 'pino';
import { env, isTest } from './env.js';
import { getContext } from '../utils/requestContext.js';

// Anything that could carry a credential is redacted, wherever it appears in a log object.
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.token',
  '*.idToken',
  '*.accessToken',
  '*.refreshToken',
  '*.apikey',
  '*.apiKey',
  '*.secret',
  '*.totpCode',
];

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'gambknd' },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const ctx = getContext();
    return ctx ? { requestId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) } : {};
  },
  formatters: { level: (label: string) => ({ level: label }) },
});

export type Logger = typeof logger;
