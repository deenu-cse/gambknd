import type { Request, RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';
import { setContextUser } from '../utils/requestContext.js';
import { COOKIE_NAMES, verifyAccessToken } from '../modules/auth/tokens.js';
import { isSessionRevoked } from '../modules/auth/session.service.js';
import type { Realm } from '../modules/auth/session.model.js';
import type { UserRole } from '../modules/users/user.model.js';

export interface AuthContext {
  userId: string;
  role: UserRole;
  sessionId: string;
  realm: Realm;
}

function readToken(req: Request, realm: Realm): string | null {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[COOKIE_NAMES[realm].access] ?? null;
}

/** Verifies an access token for a realm. Shared by HTTP middleware and the socket handshake. */
export async function authenticateToken(token: string, realm: Realm): Promise<AuthContext> {
  const claims = verifyAccessToken(token, realm);
  if (await isSessionRevoked(claims.sid)) throw new AppError('UNAUTHENTICATED', 'Session has ended');
  return { userId: claims.sub, role: claims.role, sessionId: claims.sid, realm };
}

export function requireAuth(realm: Realm = 'user'): RequestHandler {
  return async (req, _res, next) => {
    const token = readToken(req, realm);
    if (!token) throw AppError.unauthenticated();
    req.auth = await authenticateToken(token, realm);
    setContextUser(req.auth.userId);
    next();
  };
}

/** Attaches req.auth when a valid token is present; never rejects. */
export function optionalAuth(realm: Realm = 'user'): RequestHandler {
  return async (req, _res, next) => {
    const token = readToken(req, realm);
    if (token) {
      try {
        req.auth = await authenticateToken(token, realm);
        setContextUser(req.auth.userId);
      } catch {
        // An invalid token on a public route is the same as no token.
      }
    }
    next();
  };
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw AppError.unauthenticated();
    if (!roles.includes(req.auth.role)) throw AppError.forbidden();
    next();
  };
}

/** Admin API guard: admin-realm token and a staff role. */
export const requireAdmin: RequestHandler[] = [requireAuth('admin'), requireRole('admin', 'superadmin')];

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth;
}

export function clientInfo(req: Request): { ip: string | null; userAgent: string | null } {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
}
