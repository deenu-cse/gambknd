import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
}

export interface GoogleVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

class OAuthGoogleVerifier implements GoogleVerifier {
  private readonly client: OAuth2Client;

  constructor(private readonly clientId: string) {
    this.client = new OAuth2Client(clientId);
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    let payload;
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.clientId });
      payload = ticket.getPayload();
    } catch {
      throw new AppError('INVALID_CREDENTIALS', 'Google sign-in failed');
    }
    if (!payload?.sub || !payload.email) throw new AppError('INVALID_CREDENTIALS', 'Google account has no email');
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: payload.name ?? payload.email.split('@')[0] ?? 'Player',
      picture: payload.picture ?? null,
    };
  }
}

let verifier: GoogleVerifier | null = env.GOOGLE_CLIENT_ID ? new OAuthGoogleVerifier(env.GOOGLE_CLIENT_ID) : null;

export function getGoogleVerifier(): GoogleVerifier {
  if (!verifier) throw new AppError('SERVICE_UNAVAILABLE', 'Google sign-in is not configured (GOOGLE_CLIENT_ID)');
  return verifier;
}

/** Test seam: swap in a fake verifier (no network). */
export function setGoogleVerifier(v: GoogleVerifier | null): void {
  verifier = v;
}
