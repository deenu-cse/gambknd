import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const REALMS = ['user', 'admin'] as const;
/** Which app a session belongs to. Admin sessions use separate cookies and shorter lifetimes. */
export type Realm = (typeof REALMS)[number];

export const REVOKE_REASONS = ['logout', 'logout_all', 'reuse_detected', 'admin_force', 'password_changed', 'suspended', 'expired_family'] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/**
 * A Session is one login on one device: the refresh-token *family*.
 * Every rotation creates a new RefreshToken in the same family (sessionId).
 */
export interface ISession {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  realm: Realm;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: RevokeReason | null;
}

const sessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    realm: { type: String, enum: REALMS, required: true },
    userAgent: { type: String, default: null, maxlength: 400 },
    ip: { type: String, default: null, maxlength: 64 },
    lastUsedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, enum: [...REVOKE_REASONS, null], default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
sessionSchema.index({ userId: 1, realm: 1, revokedAt: 1 });
// Keep revoked/expired sessions 30 days for the audit trail, then let Mongo drop them.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const Session = model<ISession>('Session', sessionSchema);
export type SessionDoc = HydratedDocument<ISession>;

export interface IRefreshToken {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  replacedBy: Types.ObjectId | null;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    replacedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const RefreshToken = model<IRefreshToken>('RefreshToken', refreshTokenSchema);
