import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithContext } from '../utils/requestContext.js';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts a well-formed inbound X-Request-Id (for tracing across services), otherwise mints one. */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.get('x-request-id');
  const id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  runWithContext({ requestId: id }, next);
};
