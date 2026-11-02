import { logger } from '../../config/logger.js';
import type { LedgerType } from './accounts.js';
import { LedgerEntry } from './ledger.model.js';
import { lifetimeEffect } from './ledger.service.js';
import { ReconciliationRun, type IReconciliationRun, type WalletMismatch } from './reconciliation.model.js';
import { Wallet } from './wallet.model.js';
import { Bet, OPEN_BET_STATUSES } from '../bets/bet.model.js';

interface Expected {
  available: number;
  locked: number;
  lifetime: { staked: number; returned: number; bonuses: number; adminCredits: number; adminDebits: number };
}

const emptyExpected = (): Expected => ({
  available: 0,
  locked: 0,
  lifetime: { staked: 0, returned: 0, bonuses: 0, adminCredits: 0, adminDebits: 0 },
});

interface UserLegRow {
  _id: { userId: string; locked: boolean };
  net: number;
  count: number;
}

interface LifetimeRow {
  _id: { userId: string; type: LedgerType; reverses: string | null };
  amount: number;
}

/**
 * Rebuilds every wallet from the ledger and compares:
 *   available  = Σ(credits − debits) on user:<id>
 *   locked     = Σ(credits − debits) on user:<id>:locked
 *   balance    = available + locked
 *   lifetime.* = re-derived with the same rules the ledger uses
 *   locked     = Σ stakes of the user's open bets (PENDING_DELAY / ACCEPTED)
 * Also checks that every txn and the whole ledger sum to zero.
 */
export async function runReconciliation(trigger: IReconciliationRun['trigger'], triggeredBy: string | null = null): Promise<IReconciliationRun> {
  const run = await ReconciliationRun.create({ trigger, triggeredBy, status: 'running', startedAt: new Date() });
  try {
    const signed = { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', { $multiply: ['$amount', -1] }] };

    const [userLegs, lifetimeRows, unbalanced, totals] = await Promise.all([
      LedgerEntry.aggregate<UserLegRow>([
        { $match: { userId: { $ne: null } } },
        {
          $group: {
            _id: { userId: { $toString: '$userId' }, locked: { $regexMatch: { input: '$account', regex: ':locked$' } } },
            net: { $sum: signed },
            count: { $sum: 1 },
          },
        },
      ]).allowDiskUse(true),
      // Only one leg per posting owns the lifetime effect: the non-house user side.
      LedgerEntry.aggregate<LifetimeRow>([
        { $match: { userId: { $ne: null }, type: { $in: ['BET_STAKE_CAPTURE', 'BET_PAYOUT', 'CASHOUT', 'WELCOME_BONUS', 'DAILY_BONUS', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'BET_RESETTLE_REVERSAL'] } } },
        { $group: { _id: { userId: { $toString: '$userId' }, type: '$type', reverses: { $ifNull: ['$meta.reverses', null] } }, amount: { $sum: '$amount' } } },
      ]).allowDiskUse(true),
      LedgerEntry.aggregate<{ _id: string }>([
        { $group: { _id: '$txnId', sum: { $sum: signed } } },
        { $match: { sum: { $ne: 0 } } },
        { $limit: 1000 },
      ]).allowDiskUse(true),
      LedgerEntry.aggregate<{ _id: null; sum: number; count: number }>([{ $group: { _id: null, sum: { $sum: signed }, count: { $sum: 1 } } }]),
    ]);

    const expected = new Map<string, Expected>();
    const get = (id: string): Expected => {
      let e = expected.get(id);
      if (!e) expected.set(id, (e = emptyExpected()));
      return e;
    };
    for (const row of userLegs) {
      const e = get(row._id.userId);
      if (row._id.locked) e.locked += row.net;
      else e.available += row.net;
    }
    for (const row of lifetimeRows) {
      const effect = lifetimeEffect(row._id.type, row.amount, { reverses: row._id.reverses });
      const e = get(row._id.userId);
      for (const [k, v] of Object.entries(effect)) e.lifetime[k as keyof Expected['lifetime']] += v;
    }

    const openStakes = new Map(
      (
        await Bet.aggregate<{ _id: string; stake: number }>([
          { $match: { status: { $in: OPEN_BET_STATUSES } } },
          { $group: { _id: { $toString: '$userId' }, stake: { $sum: '$stake' } } },
        ]).allowDiskUse(true)
      ).map((r) => [r._id, r.stake]),
    );

    const mismatches: WalletMismatch[] = [];
    let walletsChecked = 0;
    const seen = new Set<string>();
    for await (const w of Wallet.find().lean().cursor()) {
      walletsChecked += 1;
      const id = w.userId.toString();
      seen.add(id);
      const e = expected.get(id) ?? emptyExpected();
      const check = (field: WalletMismatch['field'], exp: number, act: number): void => {
        if (exp !== act) mismatches.push({ userId: id, field, expected: exp, actual: act });
      };
      check('balance', e.available + e.locked, w.balance);
      check('lockedBalance', e.locked, w.lockedBalance);
      check('openBetStakes', openStakes.get(id) ?? 0, w.lockedBalance);
      for (const k of Object.keys(e.lifetime) as Array<keyof Expected['lifetime']>) check(`lifetime.${k}`, e.lifetime[k], w.lifetime[k]);
    }
    for (const id of expected.keys()) {
      if (!seen.has(id)) mismatches.push({ userId: id, field: 'missingWallet', expected: 1, actual: 0 });
    }

    const globalSum = totals[0]?.sum ?? 0;
    const clean = mismatches.length === 0 && unbalanced.length === 0 && globalSum === 0;
    run.set({
      status: clean ? 'clean' : 'mismatches',
      finishedAt: new Date(),
      walletsChecked,
      ledgerEntriesScanned: totals[0]?.count ?? 0,
      mismatches: mismatches.slice(0, 5_000),
      unbalancedTxns: unbalanced.map((u) => u._id),
      globalSum,
    });
    await run.save();
    if (!clean) logger.error({ runId: run.id as string, mismatches: mismatches.length, unbalanced: unbalanced.length, globalSum }, 'reconciliation found problems');
    return run.toObject();
  } catch (err) {
    run.set({ status: 'failed', finishedAt: new Date(), error: err instanceof Error ? err.message : String(err) });
    await run.save();
    throw err;
  }
}

export async function listReconciliationRuns(limit = 20): Promise<IReconciliationRun[]> {
  return ReconciliationRun.find().sort({ startedAt: -1 }).limit(limit).lean();
}

export async function getReconciliationRun(id: string): Promise<IReconciliationRun | null> {
  return ReconciliationRun.findById(id).lean();
}
