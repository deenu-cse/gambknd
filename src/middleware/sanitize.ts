import type { RequestHandler } from 'express';

const MAX_DEPTH = 12;

/**
 * Drops keys that could become MongoDB operators or path traversal (`$where`, `a.b`).
 * Zod validation is the main defense; this is defense in depth for anything that
 * reaches a query before (or without) a schema.
 */
export function stripMongoOperators(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((v) => stripMongoOperators(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor') continue;
      out[key] = stripMongoOperators(v, depth + 1);
    }
    return out;
  }
  return value;
}

export const sanitizeInput: RequestHandler = (req, _res, next) => {
  if (req.body !== undefined) req.body = stripMongoOperators(req.body);
  // Express 5's default "simple" query parser never produces nested objects, so req.query is flat strings.
  req.params = stripMongoOperators(req.params) as typeof req.params;
  next();
};
