import { z } from 'zod';
import { emailSchema, passwordSchema } from './password.js';

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(60),
    email: emailSchema,
    password: passwordSchema,
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms (play tokens, no cash value)' }) }),
  })
  .strict()
  .superRefine((v, ctx) => {
    const local = v.email.split('@')[0] ?? '';
    if (local.length >= 4 && v.password.toLowerCase().includes(local)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'Password must not contain your email' });
    }
  });

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
    totpCode: z.string().regex(/^\d{6}$/).optional(),
  })
  .strict();

export const googleLoginSchema = z.object({ idToken: z.string().min(20).max(4096) }).strict();

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema }).strict();

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) }).strict();

export const totpCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
