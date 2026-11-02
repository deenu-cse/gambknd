import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { findScript, type ReplayScript } from './scripts.js';
import { synthesizeMatch, type SynthesizedMatch } from './synthesizer.js';

export type ReplayStatus = 'scheduled' | 'running' | 'paused' | 'finished';
export type ReplayAction = 'start' | 'pause' | 'rain' | 'resume' | 'abandon' | 'finish' | 'outage_on' | 'outage_off';

export interface ReplaySession {
  id: string;
  scriptId: string;
  providerId: string;
  seed: string;
  status: ReplayStatus;
  pauseReason: 'manual' | 'rain' | null;
  abandoned: boolean;
  /** Simulated provider outage: every provider call for this match fails (tests stale-data handling). */
  outage: boolean;
  intervalMs: number;
  /** Index of the last applied timeline step; -1 = not started. */
  cursor: number;
  nextStepAt: number;
  startAt: number;
  createdAt: number;
  finishedAt: number | null;
}

export type Step = { kind: 'TOSS' } | { kind: 'BALL'; innings: 1 | 2; index: number } | { kind: 'BREAK' } | { kind: 'END' };

export const BREAK_STEPS = 3;
const MAX_CATCH_UP = 6;
const KEY = (id: string): string => `replay:session:${id}`;
const INDEX = 'replay:sessions';

const timelines = new Map<string, Step[]>();

export function timelineFor(script: ReplayScript, synth: SynthesizedMatch, seed: string): Step[] {
  const key = `${script.id}:${seed}`;
  const hit = timelines.get(key);
  if (hit) return hit;
  const steps: Step[] = [{ kind: 'TOSS' }];
  synth.innings[0].forEach((_, index) => steps.push({ kind: 'BALL', innings: 1, index }));
  for (let i = 0; i < BREAK_STEPS; i += 1) steps.push({ kind: 'BREAK' });
  synth.innings[1].forEach((_, index) => steps.push({ kind: 'BALL', innings: 2, index }));
  steps.push({ kind: 'END' });
  timelines.set(key, steps);
  return steps;
}

export interface ResolvedSession {
  session: ReplaySession;
  script: ReplayScript;
  synth: SynthesizedMatch;
  steps: Step[];
}

export function resolve(session: ReplaySession): ResolvedSession | null {
  const script = findScript(session.scriptId);
  if (!script) return null;
  const synth = synthesizeMatch(script, session.seed);
  return { session, script, synth, steps: timelineFor(script, synth, session.seed) };
}

const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export class ReplaySessionStore {
  constructor(private readonly redis: Redis) {}

  /**
   * Admin controls (API process) and the driver tick (worker) both read-modify-write a session;
   * a short per-session lock keeps one from overwriting the other.
   */
  private async locked<T>(id: string, waitMs: number, fn: () => Promise<T>): Promise<T | null> {
    const key = `lock:replay:${id}`;
    const token = randomBytes(8).toString('hex');
    const deadline = Date.now() + waitMs;
    while ((await this.redis.set(key, token, 'PX', 5_000, 'NX')) !== 'OK') {
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
    try {
      return await fn();
    } finally {
      await this.redis.eval(RELEASE_LUA, 1, key, token);
    }
  }

  async create(input: { scriptId: string; intervalMs: number; startInSec: number; seed?: string }): Promise<ReplaySession> {
    if (!findScript(input.scriptId)) throw new Error(`unknown replay script: ${input.scriptId}`);
    const id = randomBytes(6).toString('hex');
    const now = Date.now();
    const session: ReplaySession = {
      id,
      scriptId: input.scriptId,
      providerId: `replay-${id}`,
      seed: input.seed ?? id,
      status: 'scheduled',
      pauseReason: null,
      abandoned: false,
      outage: false,
      intervalMs: input.intervalMs,
      cursor: -1,
      nextStepAt: 0,
      startAt: now + input.startInSec * 1000,
      createdAt: now,
      finishedAt: null,
    };
    await this.redis.multi().set(KEY(id), JSON.stringify(session)).zadd(INDEX, now, id).exec();
    return session;
  }

  async get(id: string): Promise<ReplaySession | null> {
    const raw = await this.redis.get(KEY(id));
    return raw ? (JSON.parse(raw) as ReplaySession) : null;
  }

  async getByProviderId(providerId: string): Promise<ReplaySession | null> {
    return providerId.startsWith('replay-') ? this.get(providerId.slice('replay-'.length)) : null;
  }

  async list(limit = 50): Promise<ReplaySession[]> {
    const ids = await this.redis.zrevrange(INDEX, 0, limit - 1);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map(KEY));
    return raws.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as ReplaySession);
  }

  async save(session: ReplaySession): Promise<void> {
    await this.redis.set(KEY(session.id), JSON.stringify(session));
  }

  async remove(id: string): Promise<void> {
    await this.redis.multi().del(KEY(id)).zrem(INDEX, id).exec();
  }

  /** Admin controls. Returns the updated session. */
  async control(id: string, action: ReplayAction, now = Date.now()): Promise<ReplaySession> {
    const out = await this.locked(id, 2_000, () => this.applyControl(id, action, now));
    if (!out) throw new Error('replay session is busy, try again');
    return out;
  }

  private async applyControl(id: string, action: ReplayAction, now: number): Promise<ReplaySession> {
    const s = await this.get(id);
    if (!s) throw new Error('replay session not found');
    const resolved = resolve(s);
    if (!resolved) throw new Error('replay script missing');
    switch (action) {
      case 'start':
        if (s.status === 'scheduled') Object.assign(s, { status: 'running', startAt: Math.min(s.startAt, now), nextStepAt: now });
        break;
      case 'pause':
      case 'rain':
        if (s.status === 'running') Object.assign(s, { status: 'paused', pauseReason: action === 'rain' ? 'rain' : 'manual' });
        break;
      case 'resume':
        if (s.status === 'paused') Object.assign(s, { status: 'running', pauseReason: null, nextStepAt: now });
        break;
      case 'abandon':
        if (s.status !== 'finished') Object.assign(s, { status: 'finished', abandoned: true, pauseReason: null, finishedAt: now });
        break;
      case 'finish':
        if (s.status !== 'finished') Object.assign(s, { status: 'finished', cursor: resolved.steps.length - 1, pauseReason: null, finishedAt: now });
        break;
      case 'outage_on':
        s.outage = true;
        break;
      case 'outage_off':
        s.outage = false;
        break;
    }
    await this.save(s);
    return s;
  }

  async setSpeed(id: string, intervalMs: number): Promise<ReplaySession> {
    const out = await this.locked(id, 2_000, async () => {
      const s = await this.get(id);
      if (!s) throw new Error('replay session not found');
      s.intervalMs = intervalMs;
      if (s.status === 'running') s.nextStepAt = Math.min(s.nextStepAt, Date.now() + intervalMs);
      await this.save(s);
      return s;
    });
    if (!out) throw new Error('replay session is busy, try again');
    return out;
  }

  /** Driver tick: kick off due matches and move running ones forward on schedule. */
  async advanceAll(now = Date.now()): Promise<ReplaySession[]> {
    const changed: ReplaySession[] = [];
    for (const listed of await this.list(200)) {
      if (listed.status === 'finished' || listed.status === 'paused') continue;
      const moved = await this.locked(listed.id, 0, () => this.advanceOne(listed.id, now));
      if (moved) changed.push(moved);
    }
    return changed;
  }

  private async advanceOne(id: string, now: number): Promise<ReplaySession | null> {
    const s = await this.get(id);
    const r = s ? resolve(s) : null;
    if (!s || !r) return null;
    const before = `${s.status}:${s.cursor}`;
    if (s.status === 'scheduled' && now >= s.startAt) Object.assign(s, { status: 'running', nextStepAt: now });
    if (s.status === 'running' && now >= s.nextStepAt) {
      const due = Math.min(MAX_CATCH_UP, Math.floor((now - s.nextStepAt) / s.intervalMs) + 1);
      s.cursor = Math.min(r.steps.length - 1, s.cursor + due);
      s.nextStepAt += due * s.intervalMs;
      if (s.cursor >= r.steps.length - 1) Object.assign(s, { status: 'finished', finishedAt: now });
    }
    if (`${s.status}:${s.cursor}` === before) return null;
    await this.save(s);
    return s;
  }
}
