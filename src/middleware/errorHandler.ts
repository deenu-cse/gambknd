import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { AppError, isAppError } from '../utils/errors.js';
import { failureBody } from '../utils/http.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

interface HttpLikeError {
  type?: string;
  status?: number;
  code?: number;
  keyValue?: Record<string, unknown>;
}

function normalize(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (err instanceof ZodError) {
    return new AppError(
      'VALIDATION_ERROR',
      'Request validation failed',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return new AppError(
      'VALIDATION_ERROR',
      'Document validation failed',
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
    );
  }
  if (err instanceof mongoose.Error.CastError) {
    return new AppError('VALIDATION_ERROR', `Invalid value for ${err.path}`);
  }
  const e = (err ?? {}) as HttpLikeError;
  if (e.code === 11000) {
    return new AppError('CONFLICT', 'Duplicate value', { fields: Object.keys(e.keyValue ?? {}) });
  }
  if (e.type === 'entity.parse.failed') return new AppError('BAD_REQUEST', 'Malformed JSON body');
  if (e.type === 'entity.too.large') return new AppError('PAYLOAD_TOO_LARGE', 'Request body too large');
  return new AppError('INTERNAL_ERROR', 'Something went wrong');
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const appErr = normalize(err);
  if (appErr.status >= 500) {
    logger.error({ err, method: req.method, path: req.path }, 'request failed');
  } else {
    logger.debug({ code: appErr.code, path: req.path }, 'request rejected');
  }
  if (res.headersSent) return;
  res.status(appErr.status).json(failureBody(appErr.code, appErr.message, appErr.details));
};
