import { Types } from 'mongoose';
import { z } from 'zod';
import { LEDGER_TYPES } from './accounts.js';

const csvTypes = z
  .string()
  .transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean))
  .pipe(z.array(z.enum(LEDGER_TYPES)).max(LEDGER_TYPES.length));

export const transactionsQuerySchema = z
  .object({
    type: csvTypes.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: z.string().refine((v) => Types.ObjectId.isValid(v), 'invalid cursor').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const adminAdjustmentSchema = z
  .object({
    /** Minor units. 1 token = 100. */
    amount: z.number().int().positive(),
    reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500),
    idempotencyKey: z.string().uuid('idempotencyKey must be a UUID'),
  })
  .strict();

export type TransactionsQueryInput = z.infer<typeof transactionsQuerySchema>;
export type AdminAdjustmentBody = z.infer<typeof adminAdjustmentSchema>;
