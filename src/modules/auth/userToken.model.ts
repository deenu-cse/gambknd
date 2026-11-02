import { Schema, model, type Types } from 'mongoose';

export const USER_TOKEN_TYPES = ['EMAIL_VERIFY', 'PASSWORD_RESET'] as const;
export type UserTokenType = (typeof USER_TOKEN_TYPES)[number];

/** Single-use tokens sent by email. Only the hash is stored. */
export interface IUserToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: UserTokenType;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

const userTokenSchema = new Schema<IUserToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: USER_TOKEN_TYPES, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
userTokenSchema.index({ tokenHash: 1 }, { unique: true });
userTokenSchema.index({ userId: 1, type: 1 });
userTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const UserToken = model<IUserToken>('UserToken', userTokenSchema);
