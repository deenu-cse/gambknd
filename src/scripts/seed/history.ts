import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { getReplayStore } from '../../providers/cricket/index.js';
import { Rng } from '../../providers/cricket/replay/rng.js';
import { replayScripts, type ReplayScript } from '../../providers/cricket/replay/scripts.js';
import { AuditLog } from '../../modules/audit/audit.model.js';
import { Bet, type IBet } from '../../modules/bets/bet.model.js';
import { executeCashout, getCashoutQuote } from '../../modules/bets/cashout.service.js';
import { placeBet } from '../../modules/bets/placement.service.js';
import { Market, type IMarket } from '../../modules/markets/market.model.js';
import { Match } from '../../modules/matches/match.model.js';
import { Notification } from '../../modules/notifications/notification.model.js';
import { LedgerEntry } from '../../modules/wallet/ledger.model.js';
import { replayTick } from '../../workers/poller.js';
import { AppError } from '../../utils/errors.js';
import type { People, Person } from './people.js';

const DAY_MS = 24 * 3600 * 1000;
const BETTING_DAYS_AGO = [28, 26, 23, 21, 18, 16, 13, 11, 9, 7, 5, 3, 2, 1, 0];
const MATCHES_PER_DAY = 2;
const UPCOMING_START_IN_SEC = [2 * 3600, 6 * 3600, 24 * 3600];
const INTERVAL_MS = 20_000;

interface Staged {
  script: ReplayScript;
  sessionId: string;
  matchId: Types.ObjectId;
}

const rng = new Rng(20261031);

function pick<T>(items: readonly T[]): T {
  const item = items[rng.int(0, items.length - 1)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

/** Mostly small stakes with the odd big one, in whole tokens. People stake less on a long shot. */
function stakeFor(market: IMarket, selectionId: string): number {
  const r = rng.next();
  const tokens = r < 0.7 ? rng.int(10, 150) : r < 0.95 ? rng.int(150, 800) : rng.int(800, 2500);
  const odds = market.selections.find((s) => s.id === selectionId)?.odds ?? 200;
  return Math.max(10, Math.round((tokens * Math.min(200, 40_000 / odds)) / 200)) * 100;
}

async function stage(script: ReplayScript, startInSec: number, n: number): Promise<Staged> {
  const store = getReplayStore();
  const session = await store.create({ scriptId: script.id, intervalMs: INTERVAL_MS, startInSec, seed: `seed-${n}` });
  await replayTick();
  const match = await Match.findOne({ 'providerRef.id': session.providerId }).select('_id').lean();
  if (!match) throw new Error(`replay ${script.id} produced no match`);
  return { script, sessionId: session.id, matchId: match._id };
}

const openMarkets = (matchId: Types.ObjectId): Promise<IMarket[]> => Market.find({ matchId, status: 'OPEN' }).lean();

/** Limits, liability caps and balance checks stay in force: a refused bet just doesn't happen. */
async function bet(person: Person, legs: Array<{ market: IMarket; selectionId: string }>, amount: number): Promise<string | null> {
  try {
    const input = {
      legs: legs.map(({ market, selectionId }) => ({ marketId: market._id.toString(), selectionId, odds: market.selections.find((s) => s.id === selectionId)?.odds ?? 0 })),
      stake: amount,
      idempotencyKey: randomUUID(),
    };
    const { bet: placed } = await placeBet({ userId: person.id, ip: '127.0.0.1', userAgent: 'seed' }, input);
    return placed.id;
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
}

/** Favourites attract more money, so prices near evens are picked more often than long shots. */
function chooseSelection(market: IMarket): string {
  const active = market.selections.filter((s) => s.status === 'ACTIVE');
  const weights = active.map((s) => 1 / s.odds);
  let roll = rng.next() * weights.reduce((a, b) => a + b, 0);
  for (const [i, s] of active.entries()) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return s.id;
  }
  return active[0]?.id ?? '';
}

async function placeRoundOfBets(people: People, staged: Staged[]): Promise<string[]> {
  const placed: string[] = [];
  for (const s of staged) {
    const markets = await openMarkets(s.matchId);
    if (markets.length === 0) continue;
    for (const player of people.players) {
      if (player.id === people.sharp.id || rng.next() > 0.6) continue;
      for (let i = rng.int(1, 3); i > 0; i -= 1) {
        const market = pick(markets);
        const selectionId = chooseSelection(market);
        const id = await bet(player, [{ market, selectionId }], stakeFor(market, selectionId));
        if (id) placed.push(id);
      }
    }
    const winner = markets.find((m) => m.type === 'MATCH_WINNER');
    const winningSelection = winner?.selections.find((sel) => sel.teamKey === s.script.result.winnerKey);
    if (winner && winningSelection) {
      const id = await bet(people.sharp, [{ market: winner, selectionId: winningSelection.id }], rng.int(200, 600) * 100);
      if (id) placed.push(id);
    }
  }
  return placed;
}

async function placeAcca(people: People, staged: Staged[]): Promise<string | null> {
  const legs = await Promise.all(
    staged.map(async (s) => {
      const market = (await openMarkets(s.matchId)).find((m) => m.type === 'MATCH_WINNER');
      return market ? { market, selectionId: chooseSelection(market) } : null;
    }),
  );
  const ready = legs.filter((l) => l !== null);
  return ready.length === staged.length && ready.length > 1 ? bet(pick(people.players), ready, rng.int(20, 200) * 100) : null;
}

async function cashOutOne(placed: string[]): Promise<void> {
  // Cash-out is offered on Match Winner singles only.
  const open = await Bet.findOne({ _id: { $in: placed }, status: 'ACCEPTED', kind: 'SINGLE', 'legs.marketType': 'MATCH_WINNER' }).lean();
  if (!open) return;
  const userId = open.userId.toString();
  try {
    const quote = await getCashoutQuote(userId, open._id.toString());
    await executeCashout(userId, open._id.toString(), quote.quoteToken);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
}

async function finish(staged: Staged[]): Promise<void> {
  const store = getReplayStore();
  for (const s of staged) {
    await store.control(s.sessionId, 'start');
    await store.control(s.sessionId, 'finish');
  }
  await replayTick();
}

/**
 * Everything above ran through the real services. Only the dates move, so amounts, keys and
 * balances stay exactly as those services wrote them. Raw driver: this is the one place allowed
 * to touch finished ledger rows, and only their timestamps, before the app has ever served them.
 */
async function moveIntoThePast(staged: Staged[], daysAgo: number): Promise<void> {
  const delta = -daysAgo * DAY_MS - rng.int(0, 6 * 3600) * 1000;
  const shift = (...fields: string[]) => [{ $set: Object.fromEntries(fields.map((f) => [f, { $cond: [{ $eq: [{ $type: `$${f}` }, 'date'] }, { $add: [`$${f}`, delta] }, `$${f}`] }])) }];
  const matchIds = staged.map((s) => s.matchId);
  const markets = await Market.find({ matchId: { $in: matchIds } }).select('_id').lean();
  const bets: Array<Pick<IBet, '_id'>> = await Bet.find({ 'legs.matchId': { $in: matchIds } }).select('_id').lean();
  const betIds = bets.map((b) => b._id.toString());
  await Promise.all([
    Match.collection.updateMany({ _id: { $in: matchIds } }, shift('startTime', 'startedAt', 'endedAt', 'lastSyncedAt', 'createdAt', 'updatedAt')),
    Market.collection.updateMany({ matchId: { $in: matchIds } }, shift('settledAt', 'closedAt', 'lastPricedAt', 'lastSuspendedAt', 'createdAt', 'updatedAt')),
    Bet.collection.updateMany({ 'legs.matchId': { $in: matchIds } }, shift('placedAt', 'acceptedAt', 'settledAt', 'createdAt', 'updatedAt')),
    LedgerEntry.collection.updateMany({ refType: 'bet', refId: { $in: betIds } }, shift('createdAt')),
    Notification.collection.updateMany({ 'data.betId': { $in: betIds } }, shift('createdAt')),
    AuditLog.collection.updateMany({ targetType: 'market', targetId: { $in: markets.map((m) => m._id.toString()) } }, shift('createdAt')),
  ]);
}

export async function seedHistory(people: People): Promise<{ matches: number; bets: number }> {
  const scripts = replayScripts();
  const playable = scripts.filter((s) => s.result.type === 'WIN' && s.result.confident);
  let n = 0;
  let total = 0;
  for (const daysAgo of BETTING_DAYS_AGO) {
    const staged: Staged[] = [];
    for (let i = 0; i < MATCHES_PER_DAY; i += 1) staged.push(await stage(pick(playable), 3600, (n += 1)));
    const placed = await placeRoundOfBets(people, staged);
    const acca = await placeAcca(people, staged);
    if (acca) placed.push(acca);
    await cashOutOne(placed);
    await finish(staged);
    await moveIntoThePast(staged, daysAgo);
    total += placed.length;
  }
  return { matches: n, bets: total };
}

export async function seedUpcoming(people: People): Promise<number> {
  const playable = replayScripts();
  const staged: Staged[] = [];
  for (const [i, startIn] of UPCOMING_START_IN_SEC.entries()) staged.push(await stage(pick(playable), startIn, 1000 + i));
  await placeRoundOfBets(people, staged);
  await Match.updateOne({ _id: staged[0]?.matchId }, { $set: { featured: true } });
  return staged.length;
}
