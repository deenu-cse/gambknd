#!/usr/bin/env node
// Local dev infrastructure without Docker: a single-node MongoDB replica set
// (transactions need a replset) and a portable Redis. Usage: node scripts/infra.mjs start|stop|status
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.data');
const pidFile = path.join(dataDir, 'infra-pids.json');

const MONGO_PORT = Number(process.env.INFRA_MONGO_PORT ?? 27018);
const REDIS_PORT = Number(process.env.INFRA_REDIS_PORT ?? 6379);
const REPLSET = process.env.INFRA_REPLSET ?? 'rs0';

const isWin = process.platform === 'win32';
const MONGOD_BIN =
  process.env.MONGOD_BIN ??
  (isWin && existsSync('C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe')
    ? 'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe'
    : 'mongod');
const REDIS_BIN =
  process.env.REDIS_BIN ??
  (isWin ? path.join(root, '.tools', 'redis', 'redis-server.exe') : 'redis-server');

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(port, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not open port ${port} within ${timeoutMs}ms`);
}

function readPids() {
  try { return JSON.parse(readFileSync(pidFile, 'utf8')); } catch { return {}; }
}

function launch(bin, args, label) {
  if (bin.includes(path.sep) && !existsSync(bin)) {
    throw new Error(`${label} binary not found at ${bin}. Set ${label === 'mongod' ? 'MONGOD_BIN' : 'REDIS_BIN'}.`);
  }
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

async function initReplSet() {
  const client = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}/?directConnection=true`, {
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  try {
    const admin = client.db('admin');
    try {
      await admin.command({ replSetGetStatus: 1 });
      return 'already initiated';
    } catch (err) {
      if (err?.codeName !== 'NotYetInitialized') throw err;
    }
    await admin.command({
      replSetInitiate: { _id: REPLSET, members: [{ _id: 0, host: `127.0.0.1:${MONGO_PORT}` }] },
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const hello = await admin.command({ hello: 1 });
      if (hello.isWritablePrimary) return 'initiated';
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('replica set did not elect a primary in time');
  } finally {
    await client.close();
  }
}

async function start() {
  mkdirSync(path.join(dataDir, 'mongo'), { recursive: true });
  mkdirSync(path.join(dataDir, 'redis'), { recursive: true });
  const pids = readPids();

  if (await portOpen(MONGO_PORT)) {
    console.log(`mongod already listening on ${MONGO_PORT}`);
  } else {
    pids.mongod = launch(MONGOD_BIN, [
      '--replSet', REPLSET, '--port', String(MONGO_PORT), '--bind_ip', '127.0.0.1',
      '--dbpath', path.join(dataDir, 'mongo'), '--logpath', path.join(dataDir, 'mongod.log'), '--logappend',
    ], 'mongod');
    await waitForPort(MONGO_PORT, 'mongod');
    console.log(`mongod started (pid ${pids.mongod}) on ${MONGO_PORT}`);
  }
  console.log(`replica set ${REPLSET}: ${await initReplSet()}`);

  if (await portOpen(REDIS_PORT)) {
    console.log(`redis already listening on ${REDIS_PORT}`);
  } else {
    pids.redis = launch(REDIS_BIN, [
      '--port', String(REDIS_PORT), '--bind', '127.0.0.1',
      '--dir', path.join(dataDir, 'redis'), '--appendonly', 'yes', '--save', '',
    ], 'redis');
    await waitForPort(REDIS_PORT, 'redis');
    console.log(`redis started (pid ${pids.redis}) on ${REDIS_PORT}`);
  }
  writeFileSync(pidFile, JSON.stringify(pids, null, 2));
  console.log(`\nMONGO_URI=mongodb://127.0.0.1:${MONGO_PORT}/gamb?replicaSet=${REPLSET}`);
  console.log(`REDIS_URL=redis://127.0.0.1:${REDIS_PORT}`);
}

async function stop() {
  if (await portOpen(MONGO_PORT)) {
    const client = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}/?directConnection=true`);
    try {
      await client.connect();
      await client.db('admin').command({ shutdown: 1 }).catch(() => undefined); // connection drops on success
    } finally {
      await client.close().catch(() => undefined);
    }
    console.log('mongod stopped');
  }
  if (await portOpen(REDIS_PORT)) {
    await new Promise((resolve) => {
      const socket = net.connect({ port: REDIS_PORT, host: '127.0.0.1' }, () => socket.write('SHUTDOWN\r\n'));
      socket.on('close', resolve);
      socket.on('error', resolve);
    });
    console.log('redis stopped');
  }
  rmSync(pidFile, { force: true });
}

async function status() {
  console.log(`mongod :${MONGO_PORT} ${(await portOpen(MONGO_PORT)) ? 'UP' : 'down'}`);
  console.log(`redis  :${REDIS_PORT} ${(await portOpen(REDIS_PORT)) ? 'UP' : 'down'}`);
}

const cmd = process.argv[2];
const actions = { start, stop, status };
if (!actions[cmd]) {
  console.error('usage: node scripts/infra.mjs start|stop|status');
  process.exit(1);
}
actions[cmd]().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
