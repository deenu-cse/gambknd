import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/**
 * Materialized view of the user's ledger accounts, maintained in the same transaction
 * as every posting. The ledger is the source of truth; reconciliation re-derives these.
 */
export interface IWallet {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** Total tokens owned, including those locked in open bets (= user:<id> + user:<id>:locked). */
  balance: number;
  /** Tokens committed to open bets (= user:<id>:locked). */
  lockedBalance: number;
  /** Optimistic concurrency counter, +1 on every posting. */
  version: number;
  lifetime: {
    staked: number; // stakes of settled bets (captured by the house)
    returned: number; // payouts + cash-outs
    bonuses: number;
    adminCredits: number;
    adminDebits: number;
  };
  lastDailyBonusAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WalletDoc = HydratedDocument<IWallet>;

const int = { type: Number, required: true, default: 0, validate: { validator: Number.isSafeInteger, message: 'must be an integer' } };

const walletSchema = new Schema<IWallet>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    balance: int,
    lockedBalance: { ...int, min: 0 },
    version: int,
    lifetime: {
      staked: int,
      returned: int,
      bonuses: int,
      adminCredits: int,
      adminDebits: int,
    },
    lastDailyBonusAt: { type: Date, default: null },
  },
  { timestamps: true },
);
walletSchema.index({ userId: 1 }, { unique: true });
walletSchema.index({ balance: -1 });

export const Wallet = model<IWallet>('Wallet', walletSchema);
