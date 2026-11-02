import mongoose, { type ClientSession } from 'mongoose';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectMongo(uri: string): Promise<typeof mongoose> {
  mongoose.connection.on('disconnected', () => logger.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongo reconnected'));
  const conn = await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 50,
    autoIndex: true,
  });
  // Transactions (the ledger) need a replica set. Fail fast instead of at the first transfer.
  const hello = (await conn.connection.db?.admin().command({ hello: 1 })) as { setName?: string } | undefined;
  if (!hello?.setName) {
    throw new Error('MongoDB must run as a replica set (transactions are required). See README: npm run infra:start');
  }
  logger.info({ replSet: hello.setName }, 'mongo connected');
  return conn;
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

const TRANSIENT_LABELS = ['TransientTransactionError', 'UnknownTransactionCommitResult'];

function hasTransientLabel(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { hasErrorLabel?: (l: string) => boolean; errorLabels?: string[] };
  return TRANSIENT_LABELS.some((l) => e.hasErrorLabel?.(l) ?? e.errorLabels?.includes(l) ?? false);
}

/**
 * Runs `fn` inside a MongoDB transaction and retries on transient transaction errors
 * (write conflicts, primary step-down). `fn` must be idempotent within the transaction:
 * it may be re-run from the start.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>, maxAttempts = 5): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const session = await mongoose.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(
        async () => {
          result = await fn(session);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' },
      );
      return result as T;
    } catch (err) {
      if (attempt < maxAttempts && hasTransientLabel(err)) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 20));
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}
