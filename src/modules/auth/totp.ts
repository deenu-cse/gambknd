import { authenticator } from 'otplib';
import { env } from '../../config/env.js';
import { decrypt, encrypt } from '../../utils/crypto.js';

// Accept the previous and next 30s step to tolerate clock drift.
authenticator.options = { window: 1 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpUri(email: string, secret: string): string {
  return authenticator.keyuri(email, 'Gamb Admin', secret);
}

export function verifyTotp(code: string, secret: string): boolean {
  return /^\d{6}$/.test(code) && authenticator.check(code, secret);
}

export const sealSecret = (secret: string): string => encrypt(secret, env.TOTP_ENC_KEY);
export const openSecret = (sealed: string): string => decrypt(sealed, env.TOTP_ENC_KEY);
