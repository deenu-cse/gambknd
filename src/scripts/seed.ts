/**
 * Fills a development database with a believable platform.
 *   npm run seed            adds anything missing; a database that already has bets keeps them
 *   npm run seed -- --reset wipes the local database and Redis first
 * Stop the API and worker first. Passwords come from .env (SUPERADMIN_*, SEED_PASSWORD).
 */
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { closeRedis, getRedis } from '../config/redis.js';
import { Bet } from '../modules/bets/bet.model.js';
import { setAcceptanceScheduler } from '../modules/bets/placement.service.js';
import { rebuildLeaderboards } from '../modules/leaderboard/leaderboard.service.js';
import { onMatchChange, setReopenScheduler } from '../modules/markets/engine.js';
import { registerMatchChangeHandler } from '../modules/matches/matchEvents.js';
import { getSettings, invalidateSettingsCache } from '../modules/settings/settings.service.js';
import { onMatchChangeSettle } from '../modules/settlement/settlement.handler.js';
import { runReconciliation } from '../modules/wallet/reconciliation.service.js';
import { pollerStatus } from '../workers/poller.js';
import { closeQueues } from '../workers/queues.js';
import { seedHistory, seedUpcoming } from './seed/history.js';
import { seedOperations, seedPeople, type SeedPassword } from './seed/people.js';

const WORKER_ACTIVE_MS = 15_000;

function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function passwords(): SeedPassword {
  const { SUPERADMIN_EMAIL: email, SUPERADMIN_PASSWORD: superadmin, SEED_PASSWORD: shared } = env;
  if (!email || !superadmin || !shared) throw new Error('Set SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD and SEED_PASSWORD in .env first (see .env.example).');
  return { email, superadmin, shared };
}

/** Bets are placed against replay state, so a worker ticking the same sessions would race the seed. */
async function assertWorkerStopped(): Promise<void> {
  const { lastTickAt } = await pollerStatus();
  if (lastTickAt && Date.now() - lastTickAt.getTime() < WORKER_ACTIVE_MS) throw new Error('The worker is running. Stop it (and the API) before seeding.');
}

/** Wiping is for a local throwaway database only, and never in production. */
async function reset(): Promise<void> {
  const host = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^:/?,]+)/.exec(env.MONGO_URI)?.[1] ?? '';
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error(`--reset only runs against a local database, not ${host}.`);
  const collections = await mongoose.connection.db?.collections();
  // The raw driver on purpose: the ledger's append-only guard exists for the app, not for wiping a dev database.
  await Promise.all((collections ?? []).map((c) => c.deleteMany({})));
  await getRedis().flushdb();
  invalidateSettingsCache();
  print('Database and Redis wiped.');
}

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') throw new Error('The seed never runs in production.');
  const { values } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });
  const secrets = passwords();
  logger.level = 'error';

  await connectMongo(env.MONGO_URI);
  await assertWorkerStopped();
  if (values.reset) await reset();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

  // Pre-match bets only, so nothing here needs the worker's delayed jobs. Settlement stays inline.
  setReopenScheduler(() => Promise.resolve());
  setAcceptanceScheduler(() => Promise.resolve());
  registerMatchChangeHandler('markets', onMatchChange);
  registerMatchChangeHandler('settlement', onMatchChangeSettle);

  const settings = await getSettings();
  print(`Settings ready (provider mode: ${settings.providerMode}).`);
  const people = await seedPeople(secrets);
  print(`${people.staff.length} staff and ${people.players.length} demo players ready.`);

  if (await Bet.exists({})) {
    print('Bets already exist, so history was left alone. Use --reset for a fresh start.');
  } else {
    const { matches, bets } = await seedHistory(people);
    print(`History: ${matches} finished matches, ${bets} bets, settled through the real pipeline.`);
    const upcoming = await seedUpcoming(people);
    print(`Upcoming: ${upcoming} replay matches with open markets and bets. Start the worker to play them.`);
    await seedOperations(people);
    print(`Leaderboards rebuilt from ${await rebuildLeaderboards()} settled bets.`);
  }

  const run = await runReconciliation('manual', people.superadmin.id);
  if (run.status !== 'clean') throw new Error(`Reconciliation failed after seeding: ${run.status}, ${run.mismatches.length} mismatches, ${run.unbalancedTxns.length} unbalanced.`);
  print(`Reconciliation clean: ${run.walletsChecked} wallets, ${run.ledgerEntriesScanned} ledger entries.`);

  print();
  print(`Admin app (superadmin): ${secrets.email} (password: SUPERADMIN_PASSWORD)`);
  print(`Admin app (admin):      ${people.staff[1]?.email ?? ''} (password: SEED_PASSWORD)`);
  print(`User app (player):      ${people.players[0]?.email ?? ''} (password: SEED_PASSWORD)`);
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`Seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeQueues(), disconnectMongo(), closeRedis()]);
    process.exit();
  });
