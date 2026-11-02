import { z } from 'zod';
import { passwordSchema } from '../auth/password.js';
import { ODDS_FORMATS, THEMES } from './user.model.js';

/** All token amounts in the API are integer minor units (1 token = 100). */
const minorAmount = z.number().int().min(100).max(1_000_000_000);

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    avatar: z.string().url().max(500).regex(/^https:\/\//, 'Avatar must be an https URL').nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const updatePreferencesSchema = z
  .object({
    oddsFormat: z.enum(ODDS_FORMATS).optional(),
    acceptBetterOdds: z.boolean().optional(),
    theme: z.enum(THEMES).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const responsiblePlaySchema = z
  .object({
    dailyStakeLimit: minorAmount.nullable(),
    dailyLossLimit: minorAmount.nullable(),
    sessionReminderMinutes: z.number().int().min(5).max(720).nullable(),
  })
  .strict();

export const BREAK_DURATIONS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 } as const;
export const takeBreakSchema = z.object({ duration: z.enum(['24h', '7d', '30d']) }).strict();

export const EXCLUSION_DURATIONS = { '6m': 183, '1y': 365, permanent: null } as const;
export const selfExcludeSchema = z
  .object({ duration: z.enum(['6m', '1y', 'permanent']), confirm: z.literal(true) })
  .strict();

export const changePasswordSchema = z
  .object({ currentPassword: z.string().max(128).optional(), newPassword: passwordSchema })
  .strict();

export type ResponsiblePlayInput = z.infer<typeof responsiblePlaySchema>;
