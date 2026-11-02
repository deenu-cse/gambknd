import { Types } from 'mongoose';
import { z } from 'zod';
import { BET_STATUSES } from './bet.model.js';
import { MAX_ACCA_LEGS } from './math.js';

const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'invalid id');
const leg = z.object({ marketId: objectId, selectionId: z.string().min(1).max(60), odds: z.number().int().min(101).max(10_000) }).strict();

/**
 * Accepts the single-bet shape from the spec ({ marketId, selectionId, odds, stake, idempotencyKey })
 * or a bet slip ({ legs: [...], stake, idempotencyKey }) for singles and accumulators.
 */
export const placeBetSchema = z
  .union([
    z.object({ legs: z.array(leg).min(1).max(MAX_ACCA_LEGS), stake: z.number().int().positive(), idempotencyKey: z.string().uuid(), acceptBetterOdds: z.boolean().optional() }).strict(),
    leg.extend({ stake: z.number().int().positive(), idempotencyKey: z.string().uuid(), acceptBetterOdds: z.boolean().optional() }).strict(),
  ])
  .transform((v) =>
    'legs' in v
      ? v
      : { legs: [{ marketId: v.marketId, selectionId: v.selectionId, odds: v.odds }], stake: v.stake, idempotencyKey: v.idempotencyKey, acceptBetterOdds: v.acceptBetterOdds },
  );

export const listBetsQuery = z
  .object({
    status: z.enum(['open', 'settled', 'all']).default('all'),
    matchId: objectId.optional(),
    cursor: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const cashoutSchema = z.object({ quoteToken: z.string().min(20).max(1000) }).strict();

export const adminBetsQuery = z
  .object({
    status: z.enum(BET_STATUSES).optional(),
    userId: objectId.optional(),
    matchId: objectId.optional(),
    marketId: objectId.optional(),
    minStake: z.coerce.number().int().positive().optional(),
    cursor: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const voidBetSchema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
