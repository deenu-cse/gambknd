import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../config/db.js';
import { useTestApp } from '../../tests/helpers.js';
import { User } from '../users/user.model.js';
import { availableAccount, lockedAccount } from './accounts.js';
import { LedgerEntry } from './ledger.model.js';
import { transfer, transferAll } from './ledger.service.js';
import { runReconciliation } from './reconciliation.service.js';
import { provisionWallet } from './wallet.service.js';
import { Wallet } from './wallet.model.js';
import { DEFAULT_SETTINGS } from '../settings/settings.model.js';

useTestApp();

const WELCOME = DEFAULT_SETTINGS.welcomeBonus;

async function newUserWithWallet(): Promise<string> {
  const user = await User.create({ name: 'Ledger User', email: `${randomUUID()}@example.com`, passwordHash: null });
  await withTransaction((session) => provisionWallet(user._id, session));
  return user._id.toString();
}

async function walletOf(userId: string) {
  const w = await Wallet.findOne({ userId: new Types.ObjectId(userId) }).lean();
  if (!w) throw new Error('no wallet');
  return { balance: w.balance, locked: w.lockedBalance, available: w.balance - w.lockedBalance, lifetime: w.lifetime };
}

describe('LedgerService.transfer', () => {
  it('pays the welcome bonus once, as a balanced double entry', async () => {
    const userId = await newUserWithWallet();
    expect(await walletOf(userId)).toMatchObject({ balance: WELCOME, locked: 0, available: WELCOME });
    const legs = await LedgerEntry.find({ idempotencyKey: `welcome:${userId}` }).lean();
    expect(legs).toHaveLength(2);
    expect(legs.find((l) => l.direction === 'debit')?.account).toBe('bonus_pool');
    expect(legs.find((l) => l.direction === 'credit')).toMatchObject({ account: `user:${userId}`, balanceAfter: WELCOME });
    expect(new Set(legs.map((l) => l.txnId)).size).toBe(1);
  });

  it('locks a stake without changing the total balance, then captures it', async () => {
    const userId = await newUserWithWallet();
    await transfer({ from: availableAccount(userId), to: lockedAccount(userId), amount: 300_00, type: 'BET_STAKE', idempotencyKey: 'stake:b1' });
    expect(await walletOf(userId)).toMatchObject({ balance: WELCOME, locked: 300_00, available: WELCOME - 300_00 });

    await transfer({ from: lockedAccount(userId), to: 'house', amount: 300_00, type: 'BET_STAKE_CAPTURE', idempotencyKey: 'settle:b1:capture' });
    const w = await walletOf(userId);
    expect(w).toMatchObject({ balance: WELCOME - 300_00, locked: 0 });
    expect(w.lifetime.staked).toBe(300_00);
  });

  it('settles a win atomically: capture + payout in one transaction', async () => {
    const userId = await newUserWithWallet();
    await transfer({ from: availableAccount(userId), to: lockedAccount(userId), amount: 100_00, type: 'BET_STAKE', idempotencyKey: 'stake:b2' });
    await transferAll([
      { from: lockedAccount(userId), to: 'house', amount: 100_00, type: 'BET_STAKE_CAPTURE', idempotencyKey: 'settle:b2:capture' },
      { from: 'house', to: availableAccount(userId), amount: 185_00, type: 'BET_PAYOUT', idempotencyKey: 'settle:b2:payout' },
    ]);
    const w = await walletOf(userId);
    expect(w).toMatchObject({ balance: WELCOME + 85_00, locked: 0 });
    expect(w.lifetime).toMatchObject({ staked: 100_00, returned: 185_00 });
  });

  it('is idempotent: replaying a key returns the original txn and posts nothing', async () => {
    const userId = await newUserWithWallet();
    const input = { from: availableAccount(userId), to: lockedAccount(userId), amount: 50_00, type: 'BET_STAKE' as const, idempotencyKey: 'stake:dup' };
    const first = await transfer(input);
    const second = await transfer(input);
    expect(second).toMatchObject({ txnId: first.txnId, duplicate: true });
    expect(await LedgerEntry.countDocuments({ idempotencyKey: 'stake:dup' })).toBe(2);
    expect((await walletOf(userId)).locked).toBe(50_00);
  });

  it('refuses to reuse a key for a different movement', async () => {
    const userId = await newUserWithWallet();
    await transfer({ from: availableAccount(userId), to: lockedAccount(userId), amount: 50_00, type: 'BET_STAKE', idempotencyKey: 'stake:k' });
    await expect(
      transfer({ from: availableAccount(userId), to: lockedAccount(userId), amount: 60_00, type: 'BET_STAKE', idempotencyKey: 'stake:k' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
  });

  it('rejects overspending and leaves no trace', async () => {
    const userId = await newUserWithWallet();
    await expect(
      transfer({ from: availableAccount(userId), to: lockedAccount(userId), amount: WELCOME + 1, type: 'BET_STAKE', idempotencyKey: 'stake:big' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(await LedgerEntry.countDocuments({ idempotencyKey: 'stake:big' })).toBe(0);
    expect(await walletOf(userId)).toMatchObject({ balance: WELCOME, locked: 0 });
  });

  it('refuses routes the type does not allow', async () => {
    const a = await newUserWithWallet();
    const b = await newUserWithWallet();
    // No user-to-user transfers, ever.
    await expect(transfer({ from: availableAccount(a), to: lockedAccount(b), amount: 1, type: 'BET_STAKE', idempotencyKey: 'x1' })).rejects.toThrow(/not allowed/);
    await expect(transfer({ from: 'house', to: availableAccount(a), amount: 1, type: 'ADMIN_CREDIT', idempotencyKey: 'x2' })).rejects.toThrow(/not allowed/);
    await expect(transfer({ from: availableAccount(a), to: 'house', amount: 1.5, type: 'ADMIN_DEBIT', idempotencyKey: 'x3' })).rejects.toThrow(/integer/);
  });

  it('rolls back every posting in a multi-leg unit if one fails', async () => {
    const userId = await newUserWithWallet();
    await expect(
      transferAll([
        { from: 'admin_mint', to: availableAccount(userId), amount: 10_00, type: 'ADMIN_CREDIT', idempotencyKey: 'multi:1' },
        { from: availableAccount(userId), to: lockedAccount(userId), amount: WELCOME * 10, type: 'BET_STAKE', idempotencyKey: 'multi:2' },
      ]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(await LedgerEntry.countDocuments({ idempotencyKey: /^multi:/ })).toBe(0);
    expect((await walletOf(userId)).balance).toBe(WELCOME);
  });

  it('lets only reversals push available below zero', async () => {
    const userId = await newUserWithWallet();
    await transfer({ from: 'house', to: availableAccount(userId), amount: 500_00, type: 'BET_PAYOUT', idempotencyKey: 'p1' });
    await transfer({ from: availableAccount(userId), to: 'admin_mint', amount: WELCOME + 500_00, type: 'ADMIN_DEBIT', idempotencyKey: 'drain' });
    // The payout is corrected after the user already spent it.
    await transfer({
      from: availableAccount(userId), to: 'house', amount: 500_00, type: 'BET_RESETTLE_REVERSAL',
      idempotencyKey: 'rev:p1', meta: { reverses: 'BET_PAYOUT' }, allowNegative: true,
    });
    const w = await walletOf(userId);
    expect(w.available).toBe(-500_00);
    expect(w.lifetime.returned).toBe(0);
  });

  it('keeps entries append-only', async () => {
    await newUserWithWallet();
    await expect(LedgerEntry.updateOne({}, { $set: { amount: 1 } })).rejects.toThrow(/append-only/);
    await expect(LedgerEntry.deleteMany({})).rejects.toThrow(/append-only/);
  });
});

describe('concurrency', () => {
  it('20 parallel stakes cannot overspend a wallet', async () => {
    const userId = await newUserWithWallet(); // 1,000 tokens
    const stake = 70_00; // 14 fit (980 tokens), the 15th must fail
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        transfer({ from: availableAccount(userId), to: lockedAccount(userId), amount: stake, type: 'BET_STAKE', idempotencyKey: `par:${i}` }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toBe(14);
    expect(failed.every((r) => (r).reason?.code === 'INSUFFICIENT_BALANCE')).toBe(true);
    const w = await walletOf(userId);
    expect(w.locked).toBe(14 * stake);
    expect(w.available).toBe(WELCOME - 14 * stake);
    expect(w.available).toBeGreaterThanOrEqual(0);
  });

  it('parallel replays of one key post exactly once', async () => {
    const userId = await newUserWithWallet();
    const input = { from: 'admin_mint' as const, to: availableAccount(userId), amount: 1_00, type: 'ADMIN_CREDIT' as const, idempotencyKey: 'once' };
    const results = await Promise.all(Array.from({ length: 8 }, () => transfer(input)));
    expect(new Set(results.map((r) => r.txnId)).size).toBe(1);
    expect(await LedgerEntry.countDocuments({ idempotencyKey: 'once' })).toBe(2);
    expect((await walletOf(userId)).balance).toBe(WELCOME + 1_00);
  });
});

describe('reconciliation', () => {
  it('is clean after normal activity', async () => {
    const a = await newUserWithWallet();
    await transfer({ from: availableAccount(a), to: lockedAccount(a), amount: 10_00, type: 'BET_STAKE', idempotencyKey: 'r:s' });
    await transfer({ from: lockedAccount(a), to: 'house', amount: 10_00, type: 'BET_STAKE_CAPTURE', idempotencyKey: 'r:c' });
    const run = await runReconciliation('manual');
    expect(run.status).toBe('clean');
    expect(run.globalSum).toBe(0);
    expect(run.walletsChecked).toBe(1);
  });

  it('finds a tampered wallet', async () => {
    const a = await newUserWithWallet();
    const b = await newUserWithWallet();
    // Someone edits a balance directly in the database, bypassing the ledger.
    await Wallet.updateOne({ userId: new Types.ObjectId(b) }, { $inc: { balance: 999_00 } });
    const run = await runReconciliation('manual');
    expect(run.status).toBe('mismatches');
    expect(run.mismatches).toEqual([{ userId: b, field: 'balance', expected: WELCOME, actual: WELCOME + 999_00 }]);
    expect(run.mismatches.some((m) => m.userId === a)).toBe(false);
  });

  it('finds an unbalanced transaction written behind the ledger service', async () => {
    const a = await newUserWithWallet();
    await mongoose.connection.collection('ledger_entries').insertOne({
      txnId: 'forged', account: `user:${a}`, userId: new Types.ObjectId(a), direction: 'credit', amount: 5_00,
      balanceAfter: null, type: 'ADMIN_CREDIT', idempotencyKey: 'forged', counterparty: 'admin_mint', createdAt: new Date(),
    });
    const run = await runReconciliation('manual');
    expect(run.unbalancedTxns).toContain('forged');
    expect(run.globalSum).toBe(5_00);
    expect(run.status).toBe('mismatches');
  });
});
