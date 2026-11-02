import { Router } from 'express';
import { optionalAuth, requireAdmin, requireAuth } from '../../middleware/auth.js';
import { createLimiter } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validate.js';
import { makeAuthController } from './auth.controller.js';
import {
  forgotPasswordSchema,
  googleLoginSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  totpCodeSchema,
  verifyEmailSchema,
} from './auth.schema.js';
import type { Realm } from './session.model.js';

/** One router factory, mounted at /api/auth (user) and /api/admin/auth (admin). */
export function createAuthRouter(realm: Realm): Router {
  const r = Router();
  const c = makeAuthController(realm);
  // Per-IP limits on credential endpoints; per-account lockout is enforced in the service.
  const credentialLimiter = createLimiter({ name: `${realm}:credentials`, windowMs: 60_000, limit: 20 });
  const emailLimiter = createLimiter({ name: `${realm}:email`, windowMs: 15 * 60_000, limit: 5 });

  r.post('/login', credentialLimiter, validateBody(loginSchema), c.login);
  r.post('/refresh', createLimiter({ name: `${realm}:refresh`, windowMs: 60_000, limit: 60 }), c.refresh);
  r.post('/logout', optionalAuth(realm), c.logout);
  r.post('/logout-all', requireAuth(realm), c.logoutAll);
  r.get('/me', requireAuth(realm), c.me);
  r.get('/sessions', requireAuth(realm), c.sessions);

  if (realm === 'user') {
    r.post('/register', credentialLimiter, validateBody(registerSchema), c.register);
    r.post('/google', credentialLimiter, validateBody(googleLoginSchema), c.google);
    r.post('/forgot-password', emailLimiter, validateBody(forgotPasswordSchema), c.forgotPassword);
    r.post('/reset-password', credentialLimiter, validateBody(resetPasswordSchema), c.resetPassword);
    r.post('/verify-email', credentialLimiter, validateBody(verifyEmailSchema), c.verifyEmail);
    r.post('/resend-verification', requireAuth(realm), emailLimiter, c.resendVerification);
  } else {
    r.post('/totp/setup', ...requireAdmin, c.totpSetup);
    r.post('/totp/enable', ...requireAdmin, validateBody(totpCodeSchema), c.totpEnable);
    r.post('/totp/disable', ...requireAdmin, validateBody(totpCodeSchema), c.totpDisable);
  }
  return r;
}
