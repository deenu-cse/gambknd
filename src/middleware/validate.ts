import type { RequestHandler } from 'express';
import type { z, ZodTypeAny } from 'zod';
import { AppError } from '../utils/errors.js';

function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Parses `input` with `schema` or throws a VALIDATION_ERROR with per-field details. */
export function parseOrThrow<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed', formatIssues(result.error));
  }
  return result.data as z.infer<S>;
}

/** Replaces req.body with the parsed (stripped, coerced) body. */
export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, _res, next) => {
    req.body = parseOrThrow(schema, req.body ?? {});
    next();
  };
}
