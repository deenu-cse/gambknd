import { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { isStaff, User, type UserDoc } from '../users/user.model.js';
import { toPublicUser, type PublicUser } from '../users/user.serializer.js';
import { getGoogleVerifier, type GoogleIdentity } from './google.js';
import { clearLock, clearLoginFailures, lockRemainingSec, recordLoginFailure } from './lockout.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password.js';
import type { LoginInput, RegisterInput } from './auth.schema.js';
import type { Realm } from './session.model.js';
import { createSession, revokeAllSessions, type ClientInfo, type IssuedTokens } from './session.service.js';
import { generateTotpSecret, openSecret, sealSecret, totpUri, verifyTotp } from './totp.js';
import { consumeUserToken, sendPasswordResetEmail, sendVerificationEmail } from './userToken.service.js';
import { provisionNewUser } from './provisioning.js';

export interface AuthResult {
  user: PublicUser;
  tokens: IssuedTokens;
}

function assertCanLogin(user: UserDoc): void {
  if (user.status === 'suspended') {
    throw new AppError('ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.');
  }
}

/** Self-exclusion ends by itself once its end date passes. */
async function liftExpiredExclusion(user: UserDoc): Promise<void> {
  const until = user.responsiblePlay.selfExcludedUntil;
  if (user.status === 'self_excluded' && until && until <= new Date()) {
    user.status = 'active';
    user.responsiblePlay.selfExcludedUntil = null;
    await user.save();
  }
}

async function completeLogin(user: UserDoc, realm: Realm, client: ClientInfo): Promise<AuthResult> {
  await liftExpiredExclusion(user);
  user.lastLoginAt = new Date();
  await user.save();
  const tokens = await createSession(user, realm, client);
  return { user: toPublicUser(user, { hasPassword: Boolean(user.passwordHash) }), tokens };
}

export async function register(input: RegisterInput, client: ClientInfo): Promise<AuthResult> {
  const exists = await User.exists({ email: input.email });
  if (exists) throw new AppError('EMAIL_TAKEN', 'An account with this email already exists');
  const passwordHash = await hashPassword(input.password);
  const user = await provisionNewUser({ name: input.name, email: input.email, passwordHash, emailVerified: false });
  sendVerificationEmail(user).catch((err: unknown) => logger.error({ err }, 'verification email failed'));
  return completeLogin(user, 'user', client);
}

export async function login(input: LoginInput, realm: Realm, client: ClientInfo): Promise<AuthResult> {
  const locked = await lockRemainingSec(realm, input.email);
  if (locked > 0) {
    throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', { retryAfterSec: locked });
  }

  const user = await User.findOne({ email: input.email }).select('+passwordHash +totp.secretEnc');
  const fail = async (): Promise<never> => {
    const nowLocked = await recordLoginFailure(realm, input.email);
    throw new AppError(
      nowLocked ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
      nowLocked ? 'Too many failed attempts. Try again later.' : 'Email or password is incorrect',
    );
  };

  if (!user?.passwordHash) {
    await burnPasswordCheck(input.password);
    return fail();
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) return fail();
  if (realm === 'admin' && !isStaff(user.role)) throw AppError.forbidden('Admin access required');
  assertCanLogin(user);

  if (realm === 'admin' && user.totp.enabled) {
    if (!input.totpCode) throw new AppError('TOTP_REQUIRED', 'Enter your authenticator code');
    if (!user.totp.secretEnc || !verifyTotp(input.totpCode, openSecret(user.totp.secretEnc))) {
      await recordLoginFailure(realm, input.email);
      throw new AppError('TOTP_INVALID', 'Authenticator code is incorrect');
    }
  }

  await clearLoginFailures(realm, input.email);
  const result = await completeLogin(user, realm, client);
  if (realm === 'admin') await recordAudit({ id: user._id.toString(), role: user.role, ip: client.ip }, { action: 'auth.admin_login', targetType: 'user', targetId: user._id.toString() });
  return result;
}

export async function loginWithGoogle(idToken: string, client: ClientInfo): Promise<AuthResult> {
  const verifier = getGoogleVerifier();
  let identity: GoogleIdentity;
  try {
    identity = await verifier.verify(idToken);
  } catch (err) {
    // Any failure to verify (bad signature, network, expired) is a failed sign-in, never a 500.
    if (err instanceof AppError) throw err;
    throw new AppError('INVALID_CREDENTIALS', 'Google sign-in failed');
  }

  let user = await User.findOne({ googleId: identity.sub }).select('+passwordHash');
  if (!user) {
    user = await User.findOne({ email: identity.email }).select('+passwordHash');
    if (user) {
      // Linking to an existing email account is only safe if Google vouches for the email.
      if (!identity.emailVerified) {
        throw new AppError('INVALID_CREDENTIALS', 'Your Google email is not verified, so it cannot be linked');
      }
      user.googleId = identity.sub;
      user.emailVerified = true;
      user.avatar ??= identity.picture;
      await user.save();
    } else {
      user = await provisionNewUser({
        name: identity.name.slice(0, 60),
        email: identity.email,
        passwordHash: null,
        googleId: identity.sub,
        avatar: identity.picture,
        emailVerified: identity.emailVerified,
      });
    }
  }
  assertCanLogin(user);
  return completeLogin(user, 'user', client);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const user = await User.findOne({ email }).select('_id email name status');
  // Same response whether or not the account exists (no account enumeration).
  if (!user || user.status === 'suspended') return;
  await sendPasswordResetEmail(user);
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const userId = await consumeUserToken(token, 'PASSWORD_RESET');
  const user = await User.findById(userId);
  if (!user) throw new AppError('BAD_REQUEST', 'This link is invalid or has expired');
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
  await revokeAllSessions(user._id.toString(), 'password_changed');
  await Promise.all([clearLock('user', user.email), clearLock('admin', user.email)]);
}

export async function verifyEmail(token: string): Promise<void> {
  const userId = await consumeUserToken(token, 'EMAIL_VERIFY');
  await User.updateOne({ _id: userId }, { $set: { emailVerified: true } });
}

export async function resendVerification(userId: string): Promise<void> {
  const user = await User.findById(userId).select('_id email name emailVerified');
  if (!user) throw AppError.notFound('User');
  if (user.emailVerified) throw new AppError('INVALID_STATE', 'Email is already verified');
  await sendVerificationEmail(user);
}

// ── Admin TOTP 2FA ───────────────────────────────────────────────────────────

export async function beginTotpSetup(userId: string): Promise<{ otpauthUrl: string; secret: string }> {
  const user = await User.findById(userId).select('email totp.enabled');
  if (!user) throw AppError.notFound('User');
  if (user.totp.enabled) throw new AppError('INVALID_STATE', 'Two-factor authentication is already enabled');
  const secret = generateTotpSecret();
  await User.updateOne({ _id: user._id }, { $set: { 'totp.pendingSecretEnc': sealSecret(secret) } });
  return { otpauthUrl: totpUri(user.email, secret), secret };
}

export async function enableTotp(userId: string, code: string, ip: string | null): Promise<void> {
  const user = await User.findById(userId).select('+totp.pendingSecretEnc role');
  if (!user?.totp.pendingSecretEnc) throw new AppError('INVALID_STATE', 'Start two-factor setup first');
  const secret = openSecret(user.totp.pendingSecretEnc);
  if (!verifyTotp(code, secret)) throw new AppError('TOTP_INVALID', 'Authenticator code is incorrect');
  await User.updateOne(
    { _id: user._id },
    { $set: { 'totp.enabled': true, 'totp.secretEnc': sealSecret(secret), 'totp.pendingSecretEnc': null } },
  );
  await recordAudit({ id: userId, role: user.role, ip }, { action: 'auth.totp_enabled', targetType: 'user', targetId: userId });
}

export async function disableTotp(userId: string, code: string, ip: string | null): Promise<void> {
  const user = await User.findById(userId).select('+totp.secretEnc role');
  if (!user?.totp.enabled || !user.totp.secretEnc) throw new AppError('INVALID_STATE', 'Two-factor authentication is not enabled');
  if (!verifyTotp(code, openSecret(user.totp.secretEnc))) throw new AppError('TOTP_INVALID', 'Authenticator code is incorrect');
  await User.updateOne({ _id: user._id }, { $set: { 'totp.enabled': false, 'totp.secretEnc': null } });
  await recordAudit({ id: userId, role: user.role, ip }, { action: 'auth.totp_disabled', targetType: 'user', targetId: userId });
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  if (!Types.ObjectId.isValid(userId)) throw AppError.unauthenticated();
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw AppError.unauthenticated();
  return toPublicUser(user);
}
