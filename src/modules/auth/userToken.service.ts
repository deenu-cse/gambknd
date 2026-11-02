import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { AppError } from '../../utils/errors.js';
import { sendMail } from '../../utils/mailer.js';
import { UserToken, type UserTokenType } from './userToken.model.js';

const TTL_MIN: Record<UserTokenType, number> = { EMAIL_VERIFY: 24 * 60, PASSWORD_RESET: 30 };

async function issue(userId: Types.ObjectId, type: UserTokenType): Promise<string> {
  // Only the newest link of each type is valid.
  await UserToken.updateMany({ userId, type, usedAt: null }, { $set: { usedAt: new Date() } });
  const token = randomToken(32);
  await UserToken.create({
    userId,
    type,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + TTL_MIN[type] * 60_000),
  });
  return token;
}

/** Atomically consumes a token. Returns the owning user id, or throws if invalid/expired/used. */
export async function consumeUserToken(token: string, type: UserTokenType): Promise<Types.ObjectId> {
  const doc = await UserToken.findOneAndUpdate(
    { tokenHash: sha256(token), type, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );
  if (!doc) throw new AppError('BAD_REQUEST', 'This link is invalid or has expired');
  return doc.userId;
}

export async function sendVerificationEmail(user: { _id: Types.ObjectId; email: string; name: string }): Promise<void> {
  const token = await issue(user._id, 'EMAIL_VERIFY');
  const link = `${env.USER_APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: 'Verify your Gamb email',
    text: `Hi ${user.name},\n\nConfirm your email address: ${link}\n\nThis link expires in 24 hours.\n\nGamb uses play tokens only. They have no cash value.`,
  });
}

export async function sendPasswordResetEmail(user: { _id: Types.ObjectId; email: string; name: string }): Promise<void> {
  const token = await issue(user._id, 'PASSWORD_RESET');
  const link = `${env.USER_APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your Gamb password',
    text: `Hi ${user.name},\n\nReset your password: ${link}\n\nThis link expires in 30 minutes. If you didn't ask for this, ignore this email.`,
  });
}
