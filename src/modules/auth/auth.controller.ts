import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { authOf, clientInfo } from '../../middleware/auth.js';
import { AppError } from '../../utils/errors.js';
import { sendCreated, sendOk } from '../../utils/http.js';
import * as auth from './auth.service.js';
import type { Realm } from './session.model.js';
import { listActiveSessions, revokeAllSessions, revokeSession, rotateRefreshToken, type IssuedTokens } from './session.service.js';
import { COOKIE_NAMES, REFRESH_COOKIE_PATH } from './tokens.js';
import { RefreshToken } from './session.model.js';
import { sha256 } from '../../utils/crypto.js';

function baseCookie(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

function setAuthCookies(res: Response, realm: Realm, tokens: IssuedTokens): void {
  const names = COOKIE_NAMES[realm];
  res.cookie(names.access, tokens.accessToken, {
    ...baseCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: env.JWT_ACCESS_TTL_SEC * 1000,
  });
  res.cookie(names.refresh, tokens.refreshToken, {
    ...baseCookie(),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH[realm],
    expires: tokens.refreshExpiresAt,
  });
  // Session hint (no secret, value "1"): lets the frontends' route guards know a session exists
  // even after the 15-minute access cookie expired, since the refresh cookie is path-restricted.
  res.cookie(names.hint, '1', { ...baseCookie(), sameSite: 'lax', path: '/', expires: tokens.refreshExpiresAt });
}

function clearAuthCookies(res: Response, realm: Realm): void {
  const names = COOKIE_NAMES[realm];
  res.clearCookie(names.access, { ...baseCookie(), sameSite: 'lax', path: '/' });
  res.clearCookie(names.refresh, { ...baseCookie(), sameSite: 'strict', path: REFRESH_COOKIE_PATH[realm] });
  res.clearCookie(names.hint, { ...baseCookie(), sameSite: 'lax', path: '/' });
}

function readRefreshCookie(req: Request, realm: Realm): string | undefined {
  return (req.cookies as Record<string, string | undefined> | undefined)?.[COOKIE_NAMES[realm].refresh];
}

/** Response body never includes tokens: they only travel in httpOnly cookies. */
function sessionBody(result: auth.AuthResult): { user: auth.AuthResult['user']; accessExpiresInSec: number } {
  return { user: result.user, accessExpiresInSec: env.JWT_ACCESS_TTL_SEC };
}

export function makeAuthController(realm: Realm) {
  return {
    register: async (req: Request, res: Response): Promise<void> => {
      if (realm !== 'user') throw AppError.notFound('Route');
      const result = await auth.register(req.body as Parameters<typeof auth.register>[0], clientInfo(req));
      setAuthCookies(res, realm, result.tokens);
      sendCreated(res, sessionBody(result));
    },

    login: async (req: Request, res: Response): Promise<void> => {
      const result = await auth.login(req.body as Parameters<typeof auth.login>[0], realm, clientInfo(req));
      setAuthCookies(res, realm, result.tokens);
      sendOk(res, sessionBody(result));
    },

    google: async (req: Request, res: Response): Promise<void> => {
      if (realm !== 'user') throw AppError.notFound('Route');
      const { idToken } = req.body as { idToken: string };
      const result = await auth.loginWithGoogle(idToken, clientInfo(req));
      setAuthCookies(res, realm, result.tokens);
      sendOk(res, sessionBody(result));
    },

    refresh: async (req: Request, res: Response): Promise<void> => {
      const raw = readRefreshCookie(req, realm);
      if (!raw) throw new AppError('INVALID_REFRESH_TOKEN', 'Session expired, please log in again');
      try {
        const tokens = await rotateRefreshToken(raw, realm, clientInfo(req));
        setAuthCookies(res, realm, tokens);
        sendOk(res, { user: await auth.getCurrentUser(tokens.userId), accessExpiresInSec: env.JWT_ACCESS_TTL_SEC });
      } catch (err) {
        if (err instanceof AppError && err.code !== 'REFRESH_CONFLICT') clearAuthCookies(res, realm);
        throw err;
      }
    },

    logout: async (req: Request, res: Response): Promise<void> => {
      const raw = readRefreshCookie(req, realm);
      if (raw) {
        const token = await RefreshToken.findOne({ tokenHash: sha256(raw) }).select('sessionId').lean();
        if (token) await revokeSession(token.sessionId.toString(), 'logout');
      } else if (req.auth) {
        await revokeSession(req.auth.sessionId, 'logout');
      }
      clearAuthCookies(res, realm);
      sendOk(res, { loggedOut: true });
    },

    logoutAll: async (req: Request, res: Response): Promise<void> => {
      const { userId } = authOf(req);
      const revoked = await revokeAllSessions(userId, 'logout_all', { realm });
      clearAuthCookies(res, realm);
      sendOk(res, { revoked });
    },

    me: async (req: Request, res: Response): Promise<void> => {
      sendOk(res, await auth.getCurrentUser(authOf(req).userId));
    },

    sessions: async (req: Request, res: Response): Promise<void> => {
      const { userId, sessionId } = authOf(req);
      sendOk(res, await listActiveSessions(userId, sessionId));
    },

    forgotPassword: async (req: Request, res: Response): Promise<void> => {
      await auth.requestPasswordReset((req.body as { email: string }).email);
      sendOk(res, { message: 'If that email has an account, a reset link is on its way.' });
    },

    resetPassword: async (req: Request, res: Response): Promise<void> => {
      const { token, password } = req.body as { token: string; password: string };
      await auth.resetPassword(token, password);
      clearAuthCookies(res, realm);
      sendOk(res, { message: 'Password updated. Please log in again.' });
    },

    verifyEmail: async (req: Request, res: Response): Promise<void> => {
      await auth.verifyEmail((req.body as { token: string }).token);
      sendOk(res, { verified: true });
    },

    resendVerification: async (req: Request, res: Response): Promise<void> => {
      await auth.resendVerification(authOf(req).userId);
      sendOk(res, { sent: true });
    },

    totpSetup: async (req: Request, res: Response): Promise<void> => {
      sendOk(res, await auth.beginTotpSetup(authOf(req).userId));
    },

    totpEnable: async (req: Request, res: Response): Promise<void> => {
      await auth.enableTotp(authOf(req).userId, (req.body as { code: string }).code, req.ip ?? null);
      sendOk(res, { enabled: true });
    },

    totpDisable: async (req: Request, res: Response): Promise<void> => {
      await auth.disableTotp(authOf(req).userId, (req.body as { code: string }).code, req.ip ?? null);
      sendOk(res, { enabled: false });
    },
  };
}
