import { z } from 'zod';
import { MARKET_GROUPS } from './types.js';

const reason = z.string().trim().min(3, 'Give a reason').max(300);
const odds = z.number().int().min(101).max(10_000);
const units = z.number().int().positive();

export const reasonSchema = z.object({ reason }).strict();

export const customMarketSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    group: z.enum(MARKET_GROUPS).optional(),
    inPlay: z.boolean(),
    selections: z.array(z.object({ name: z.string().trim().min(1).max(60), odds }).strict()).min(2).max(20),
    minStake: units.optional(),
    maxStake: units.optional(),
    maxLiability: units.optional(),
    betDelayMs: z.number().int().min(0).max(15_000).optional(),
    reason,
  })
  .strict();

export const editMarketSchema = z
  .object({
    name: z.string().trim().min(3).max(120).optional(),
    marginBps: z.number().int().min(0).max(3_000).optional(),
    minStake: units.optional(),
    maxStake: units.optional(),
    maxLiability: units.optional(),
    betDelayMs: z.number().int().min(0).max(15_000).optional(),
    autoManaged: z.boolean().optional(),
    odds: z.record(z.string(), odds).optional(),
    reason,
  })
  .strict();
