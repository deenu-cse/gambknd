import { Schema, model, type Types } from 'mongoose';
import { LEDGER_TYPES, type LedgerType } from './accounts.js';

export type Direction = 'debit' | 'credit';

/**
 * Double-entry, append-only. Every transfer writes exactly one debit and one credit leg
 * with the same txnId and amount, so each txn sums to zero. Never updated, never deleted.
 */
export interface ILedgerEntry {
  _id: Types.ObjectId;
  txnId: string;
  account: string;
  userId: Types.ObjectId | null; // denormalized from the account, for fast per-user queries
  direction: Direction;
  amount: number; // minor units, always > 0
  /** Balance of this account after the posting; null for system accounts (not tracked per-row). */
  balanceAfter: number | null;
  type: LedgerType;
  refType: string | null;
  refId: string | null;
  idempotencyKey: string;
  counterparty: string;
  meta: Record<string, unknown> | null;
  createdAt: Date;
}

const ledgerSchema = new Schema<ILedgerEntry>(
  {
    txnId: { type: String, required: true },
    account: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, default: null },
    direction: { type: String, enum: ['debit', 'credit'], required: true },
    amount: { type: Number, required: true, min: 1, validate: { validator: Number.isSafeInteger, message: 'amount must be an integer' } },
    balanceAfter: { type: Number, default: null },
    type: { type: String, enum: LEDGER_TYPES, required: true },
    refType: { type: String, default: null },
    refId: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
    counterparty: { type: String, required: true },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'ledger_entries' },
);

// One debit and one credit per idempotency key: a replayed transfer can never post twice.
ledgerSchema.index({ idempotencyKey: 1, direction: 1 }, { unique: true });
ledgerSchema.index({ account: 1, createdAt: -1 });
ledgerSchema.index({ userId: 1, createdAt: -1 });
ledgerSchema.index({ txnId: 1 });
ledgerSchema.index({ type: 1, createdAt: -1 });
ledgerSchema.index({ refType: 1, refId: 1 });

// Append-only guard: refuse updates and deletes through Mongoose.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  ledgerSchema.pre(op, function blockMutation() {
    throw new Error(`ledger entries are append-only (${op} refused)`);
  });
}

export const LedgerEntry = model<ILedgerEntry>('LedgerEntry', ledgerSchema);
