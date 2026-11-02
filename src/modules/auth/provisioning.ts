import { withTransaction } from '../../config/db.js';
import { AppError } from '../../utils/errors.js';
import { User, type UserDoc } from '../users/user.model.js';
import { notifyWalletChanged } from '../wallet/ledger.service.js';
import { provisionWallet } from '../wallet/wallet.service.js';

export interface NewUserInput {
  name: string;
  email: string;
  passwordHash: string | null;
  googleId?: string;
  avatar?: string | null;
  emailVerified: boolean;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * Creates a user account, its wallet and its welcome bonus atomically. A user can never
 * exist without a wallet, and the bonus (idempotency key `welcome:<id>`) is paid exactly once.
 */
export async function provisionNewUser(input: NewUserInput): Promise<UserDoc> {
  let user: UserDoc;
  try {
    user = await withTransaction(async (session) => {
      const [created] = await User.create(
        [
          {
            name: input.name,
            email: input.email,
            passwordHash: input.passwordHash,
            googleId: input.googleId ?? null,
            avatar: input.avatar ?? null,
            emailVerified: input.emailVerified,
          },
        ],
        { session },
      );
      if (!created) throw new Error('user create returned nothing');
      await provisionWallet(created._id, session);
      return created;
    });
  } catch (err) {
    if (isDuplicateKey(err) && (err as { keyPattern?: Record<string, unknown> }).keyPattern?.email !== undefined) {
      throw new AppError('EMAIL_TAKEN', 'An account with this email already exists');
    }
    throw err;
  }
  await notifyWalletChanged([user._id.toString()], 'WELCOME_BONUS');
  return user;
}
