import { Types } from 'mongoose';
import { z } from 'zod';

const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'invalid id');

export const listMatchesQuery = z
  .object({
    bucket: z.enum(['live', 'upcoming', 'recent']).default('live'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    source: z.enum(['live', 'replay']).optional(),
    seriesId: objectId.optional(),
    team: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  })
  .strict();

export const commentaryQuery = z
  .object({
    cursor: z.string().regex(/^\d+:\d+$/, 'cursor is "<innings>:<seq>"').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export const playerSearchQuery = z.object({ q: z.string().trim().min(2).max(60), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
