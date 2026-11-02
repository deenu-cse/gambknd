import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
    redisUrl: string;
  }
}

const SYSTEM_MONGOD = 'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host: '127.0.0.1' });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`redis did not start on ${port}`);
}

function redisBinary(): string {
  if (process.env.REDIS_BIN) return process.env.REDIS_BIN;
  const portable = path.resolve('.tools', 'redis', 'redis-server.exe');
  return existsSync(portable) ? portable : 'redis-server';
}

let replSet: MongoMemoryReplSet | undefined;
let redis: ChildProcess | undefined;

export async function setup(project: TestProject): Promise<void> {
  const mongodBin = process.env.MONGOD_BIN ?? (existsSync(SYSTEM_MONGOD) ? SYSTEM_MONGOD : undefined);
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // First start on Windows (antivirus scanning a fresh dbpath) can exceed the 10s default.
    instanceOpts: [{ launchTimeout: 60_000 }],
    ...(mongodBin ? { binary: { systemBinary: mongodBin } } : {}),
  });

  const port = await freePort();
  redis = spawn(redisBinary(), ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForPort(port);

  project.provide('mongoUri', replSet.getUri('gamb_test'));
  project.provide('redisUrl', `redis://127.0.0.1:${port}`);
}

export async function teardown(): Promise<void> {
  redis?.kill();
  await replSet?.stop();
}
