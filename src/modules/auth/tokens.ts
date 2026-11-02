import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import type { UserRole } from '../users/user.model.js';
import type { Realm } from './session.model.js';

const ISSUER = 'gambknd';

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
  role: UserRole;
  realm: Realm;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ sid: claims.sid, role: claims.role }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: claims.sub,
    issuer: ISSUER,
    audience: claims.realm,
    expiresIn: env.JWT_ACCESS_TTL_SEC,
  });
}

export function verifyAccessToken(token: string, realm: Realm): AccessClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: realm,
    });
    if (typeof payload === 'string' || !payload.sub || typeof payload.sid !== 'string' || typeof payload.role !== 'string') {
      throw new AppError('UNAUTHENTICATED', 'Malformed access token');
    }
    return { sub: payload.sub, sid: payload.sid, role: payload.role as UserRole, realm };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new AppError('TOKEN_EXPIRED', 'Access token expired');
    if (err instanceof AppError) throw err;
    throw new AppError('UNAUTHENTICATED', 'Invalid access token');
  }
}

/** Cookie names per realm. The user and admin apps share the localhost host, so names must differ. */
export const COOKIE_NAMES: Record<Realm, { access: string; refresh: string; hint: string }> = {
  user: { access: 'gamb_at', refresh: 'gamb_rt', hint: 'gamb_s' },
  admin: { access: 'gadm_at', refresh: 'gadm_rt', hint: 'gadm_s' },
};

/** Refresh cookies are only sent to the refresh/logout endpoints. */
export const REFRESH_COOKIE_PATH: Record<Realm, string> = {
  user: '/api/auth',
  admin: '/api/admin/auth',
};
