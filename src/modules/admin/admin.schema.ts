import { Types } from 'mongoose';
import { z } from 'zod';
import { MATCH_STATUSES } from '../../providers/cricket/types.js';
import { MARKET_TYPES } from '../markets/types.js';
import { PROVIDER_MODES } from '../settings/settings.model.js';
import { USER_ROLES, USER_STATUSES } from '../users/user.model.js';
import { LEDGER_TYPES } from '../wallet/accounts.js';

const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'invalid id');
const page = { cursor: objectId.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) };
const range = { from: z.coerce.date().optional(), to: z.coerce.date().optional() };
const units = z.number().int().positive();
const reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500);

export const adminReasonSchema = z.object({ reason }).strict();

export const adminUsersQuery = z
  .object({ q: z.string().trim().max(100).optional(), status: z.enum(USER_STATUSES).optional(), role: z.enum(USER_ROLES).optional(), ...page })
  .strict();

export const adminMatchesQuery = z
  .object({
    bucket: z.enum(['live', 'upcoming', 'recent', 'all']).default('all'),
    status: z.enum(MATCH_STATUSES).optional(),
    source: z.enum(['live', 'replay']).optional(),
    q: z.string().trim().max(100).optional(),
    ...page,
  })
  .strict();

export const chartsQuery = z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }).strict();

export const riskQuery = z
  .object({ minBets: z.coerce.number().int().min(3).max(1000).default(10), days: z.coerce.number().int().min(1).max(90).default(30) })
  .strict();

export const ledgerQuery = z
  .object({
    account: z.string().trim().max(60).optional(),
    userId: objectId.optional(),
    type: z.enum(LEDGER_TYPES).optional(),
    txnId: z.string().trim().max(60).optional(),
    refId: z.string().trim().max(100).optional(),
    idempotencyKey: z.string().trim().max(200).optional(),
    ...range,
    ...page,
  })
  .strict();

export const auditQuery = z
  .object({
    action: z.string().trim().max(60).optional(),
    actorId: objectId.optional(),
    targetType: z.string().trim().max(30).optional(),
    targetId: z.string().trim().max(100).optional(),
    ...range,
    ...page,
  })
  .strict();

const margins = z
  .record(z.string(), z.number().int().min(0).max(3_000))
  .refine((v) => Object.keys(v).every((k) => (MARKET_TYPES as readonly string[]).includes(k)), 'unknown market type');

export const settingsPatchSchema = z
  .object({
    welcomeBonus: z.number().int().min(0).optional(),
    dailyBonus: z.number().int().min(0).optional(),
    defaultMarginsBps: margins.optional(),
    defaultBetDelayMs: z.number().int().min(0).max(15_000).optional(),
    marketReopenDelayMs: z.number().int().min(0).max(30_000).optional(),
    globalMinStake: units.optional(),
    globalMaxStake: units.optional(),
    defaultMaxLiability: units.optional(),
    cashoutMarginBps: z.number().int().min(0).max(5_000).optional(),
    adminMaxAdjustment: units.optional(),
    staleThresholdMs: z.number().int().min(5_000).max(600_000).optional(),
    marketTypesEnabled: z.array(z.enum(MARKET_TYPES)).optional(),
    oneSidedThresholdBps: z.number().int().min(5_000).max(9_999).optional(),
    shadingStartBps: z.number().int().min(0).max(10_000).optional(),
    shadingMaxBoostBps: z.number().int().min(0).max(5_000).optional(),
    maintenance: z.object({ enabled: z.boolean(), message: z.string().trim().max(500) }).strict().optional(),
    providerMode: z.enum(PROVIDER_MODES).optional(),
    reason,
  })
  .strict();

export type AdminUsersQuery = z.infer<typeof adminUsersQuery>;
export type AdminMatchesQuery = z.infer<typeof adminMatchesQuery>;
export type LedgerQuery = z.infer<typeof ledgerQuery>;
export type AuditQuery = z.infer<typeof auditQuery>;
export type SettingsPatchBody = z.infer<typeof settingsPatchSchema>;
