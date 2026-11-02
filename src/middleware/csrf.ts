import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Auth uses cookies, so state-changing requests must be JSON. A cross-site HTML form
 * can't send `application/json` without a CORS preflight, and CORS only allows our two
 * frontends, so this check plus SameSite cookies blocks CSRF without a token dance.
 */
export const requireJsonForMutations: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding') !== undefined;
  if (!hasBody) {
    // Bodiless POST/DELETE (e.g. logout): require a header that only XHR/fetch can set cross-origin after preflight.
    if (req.get('x-requested-with') === 'fetch' || req.is('application/json')) return next();
    return next(new AppError('CSRF_REJECTED', 'Missing X-Requested-With header'));
  }
  if (!req.is('application/json')) {
    return next(new AppError('CSRF_REJECTED', 'Content-Type must be application/json'));
  }
  next();
};
