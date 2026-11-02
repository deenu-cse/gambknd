import { AppError } from '../../utils/errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { revokeAllSessions } from '../auth/session.service.js';
import { User, type UserDoc } from './user.model.js';
import { toPublicUser, type PublicUser } from './user.serializer.js';
import { applyDuePendingIncrease, LIMIT_INCREASE_DELAY_MS, planLimitChange } from './responsiblePlay.js';
import { BREAK_DURATIONS, EXCLUSION_DURATIONS, type ResponsiblePlayInput } from './users.schema.js';

async function load(userId: string, withPassword = false): Promise<UserDoc> {
  const q = User.findById(userId);
  const user = await (withPassword ? q.select('+passwordHash') : q);
  if (!user) throw AppError.notFound('User');
  return user;
}

async function view(user: UserDoc): Promise<PublicUser> {
  if (applyDuePendingIncrease(user.responsiblePlay)) await user.save();
  const hasPassword = (await User.exists({ _id: user._id, passwordHash: { $type: 'string' } })) !== null;
  return toPublicUser(user, { hasPassword });
}

export async function getProfile(userId: string): Promise<PublicUser> {
  return view(await load(userId));
}

export async function updateProfile(userId: string, input: { name?: string; avatar?: string | null }): Promise<PublicUser> {
  const user = await load(userId);
  if (input.name !== undefined) user.name = input.name;
  if (input.avatar !== undefined) user.avatar = input.avatar;
  await user.save();
  return view(user);
}

export async function updatePreferences(
  userId: string,
  input: Partial<Pick<UserDoc['preferences'], 'oddsFormat' | 'acceptBetterOdds' | 'theme'>>,
): Promise<PublicUser> {
  const user = await load(userId);
  Object.assign(user.preferences, input);
  await user.save();
  return view(user);
}

export async function setResponsiblePlay(userId: string, input: ResponsiblePlayInput): Promise<PublicUser> {
  const user = await load(userId);
  const rp = user.responsiblePlay;
  applyDuePendingIncrease(rp);

  const plan = planLimitChange(rp, { dailyStakeLimit: input.dailyStakeLimit, dailyLossLimit: input.dailyLossLimit });
  Object.assign(rp, plan.immediate);
  if (Object.keys(plan.deferred).length > 0) {
    rp.pendingIncrease = { ...plan.deferred, effectiveAt: new Date(Date.now() + LIMIT_INCREASE_DELAY_MS) };
  } else if (Object.keys(plan.immediate).length > 0) {
    // A new tightening cancels any loosening that was still cooling off.
    rp.pendingIncrease = null;
  }
  rp.sessionReminderMinutes = input.sessionReminderMinutes;
  await user.save();
  return view(user);
}

export async function takeBreak(userId: string, duration: keyof typeof BREAK_DURATIONS): Promise<PublicUser> {
  const user = await load(userId);
  const until = new Date(Date.now() + BREAK_DURATIONS[duration] * 3600 * 1000);
  const current = user.responsiblePlay.cooldownUntil;
  // A break can be extended but never shortened.
  if (current && current > until) throw new AppError('INVALID_STATE', 'You already have a longer break in place');
  user.responsiblePlay.cooldownUntil = until;
  await user.save();
  return view(user);
}

export async function selfExclude(userId: string, duration: keyof typeof EXCLUSION_DURATIONS): Promise<PublicUser> {
  const user = await load(userId);
  if (user.status === 'suspended') throw new AppError('ACCOUNT_SUSPENDED', 'Account is suspended');
  const days = EXCLUSION_DURATIONS[duration];
  const until = days === null ? null : new Date(Date.now() + days * 24 * 3600 * 1000);
  const current = user.responsiblePlay.selfExcludedUntil;
  if (user.status === 'self_excluded' && (current === null || (until !== null && current > until))) {
    throw new AppError('INVALID_STATE', 'You already have a longer exclusion in place');
  }
  user.status = 'self_excluded';
  user.responsiblePlay.selfExcludedUntil = until;
  await user.save();
  return view(user);
}

export async function changePassword(
  userId: string,
  currentSessionId: string,
  input: { currentPassword?: string | undefined; newPassword: string },
): Promise<void> {
  const user = await load(userId, true);
  if (user.passwordHash) {
    if (!input.currentPassword || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');
    }
  }
  user.passwordHash = await hashPassword(input.newPassword);
  await user.save();
  // Every other device has to log in again with the new password.
  await revokeAllSessions(userId, 'password_changed', { exceptSessionId: currentSessionId });
}
