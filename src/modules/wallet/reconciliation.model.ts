import { Schema, model, type Types } from 'mongoose';

export interface WalletMismatch {
  userId: string;
  field: 'balance' | 'lockedBalance' | 'lifetime.staked' | 'lifetime.returned' | 'lifetime.bonuses' | 'lifetime.adminCredits' | 'lifetime.adminDebits' | 'missingWallet' | 'openBetStakes';
  expected: number;
  actual: number;
}

export interface IReconciliationRun {
  _id: Types.ObjectId;
  trigger: 'scheduled' | 'manual';
  triggeredBy: string | null;
  status: 'running' | 'clean' | 'mismatches' | 'failed';
  startedAt: Date;
  finishedAt: Date | null;
  walletsChecked: number;
  ledgerEntriesScanned: number;
  mismatches: WalletMismatch[];
  /** txnIds whose legs don't sum to zero (should be impossible by construction). */
  unbalancedTxns: string[];
  /** Σ of every posting across all accounts; must be 0 in a closed double-entry system. */
  globalSum: number;
  error: string | null;
}

const runSchema = new Schema<IReconciliationRun>(
  {
    trigger: { type: String, enum: ['scheduled', 'manual'], required: true },
    triggeredBy: { type: String, default: null },
    status: { type: String, enum: ['running', 'clean', 'mismatches', 'failed'], required: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    walletsChecked: { type: Number, default: 0 },
    ledgerEntriesScanned: { type: Number, default: 0 },
    mismatches: [
      new Schema<WalletMismatch>({ userId: String, field: String, expected: Number, actual: Number }, { _id: false }),
    ],
    unbalancedTxns: [String],
    globalSum: { type: Number, default: 0 },
    error: { type: String, default: null },
  },
  { collection: 'reconciliation_runs' },
);
runSchema.index({ startedAt: -1 });

export const ReconciliationRun = model<IReconciliationRun>('ReconciliationRun', runSchema);
