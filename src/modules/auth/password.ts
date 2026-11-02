import argon2 from 'argon2';
import { z } from 'zod';

// OWASP-recommended argon2id baseline (19 MiB, t=2, p=1).
const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Burns the same CPU as a real check so "no such user" isn't distinguishable by timing. */
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalization');
  await verifyPassword(await dummyHash, plain);
}

const COMMON = new Set(['password', 'password1', 'password123', 'qwerty123', '12345678', '123456789', 'iloveyou', 'letmein1', 'welcome1', 'admin123']);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((p) => /[a-z]/.test(p), 'Password needs a lowercase letter')
  .refine((p) => /[A-Z]/.test(p), 'Password needs an uppercase letter')
  .refine((p) => /\d/.test(p), 'Password needs a digit')
  .refine((p) => /[^A-Za-z0-9]/.test(p), 'Password needs a symbol')
  .refine((p) => !COMMON.has(p.toLowerCase()), 'Password is too common');

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email').max(254);
