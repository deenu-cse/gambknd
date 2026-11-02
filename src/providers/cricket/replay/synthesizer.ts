import type { BallEvent, DismissalKind, SquadPlayer } from '../types.js';
import { commentaryFor } from './commentary.js';
import { Rng } from './rng.js';
import type { InningsPlan, ReplayScript } from './scripts.js';
import { pickBowlers, pickEleven } from './squads.js';

type Extra = 'wd' | 'nb' | 'lb' | 'b' | null;

interface Slot {
  legal: boolean;
  extra: Extra;
  bat: number; // bat runs
  wicket: boolean;
}

const BAT_WEIGHTS: ReadonlyArray<readonly [number, number]> = [[0, 38], [1, 36], [2, 9], [3, 1], [4, 11], [6, 5]];
const DISMISSALS: ReadonlyArray<readonly [DismissalKind, number]> = [['CAUGHT', 55], ['BOWLED', 20], ['LBW', 12], ['RUN_OUT', 8], ['STUMPED', 4], ['HIT_WICKET', 1]];
const UP: Record<number, number> = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 6 };
const DOWN: Record<number, number> = { 6: 4, 4: 3, 3: 2, 2: 1, 1: 0 };

/** Bat-run outcomes for `count` balls that sum exactly to `total` (each 0,1,2,3,4,6). */
function distribute(rng: Rng, count: number, total: number): number[] {
  if (count === 0) return [];
  const vals = Array.from({ length: count }, () => rng.weighted(BAT_WEIGHTS));
  let sum = vals.reduce((s, v) => s + v, 0);
  let guard = 0;
  while (sum !== total && guard < 100_000) {
    guard += 1;
    const i = rng.int(0, count - 1);
    const v = vals[i] as number;
    if (sum < total && v < 6) {
      const nv = total - sum >= 2 && v === 4 ? 6 : (UP[v] ?? v);
      sum += nv - v;
      vals[i] = nv;
    } else if (sum > total && v > 0) {
      const nv = sum - total >= 2 && v === 6 ? 4 : (DOWN[v] ?? v);
      sum += nv - v;
      vals[i] = nv;
    }
  }
  if (sum !== total) throw new Error(`cannot distribute ${total} runs over ${count} balls`);
  return vals;
}

/** Plans every delivery of an innings so the totals match the plan exactly. */
function planSlots(rng: Rng, plan: InningsPlan): Slot[] {
  const B = plan.balls;
  const chaseWon = plan.target !== null && plan.runs >= plan.target;
  let budget = Math.max(0, plan.runs - (chaseWon ? 1 : 0));
  const take = (n: number) => {
    const k = Math.min(n, budget);
    budget -= k;
    return k;
  };
  const wides = take(rng.int(0, Math.min(8, Math.floor(plan.runs * 0.05))));
  const noBalls = take(rng.int(0, Math.min(2, Math.floor(plan.runs * 0.02))));
  const legByes = take(rng.int(0, Math.min(4, Math.floor(plan.runs * 0.03))));
  const byes = take(rng.int(0, Math.min(2, Math.floor(plan.runs * 0.015))));

  const legal: Slot[] = Array.from({ length: B }, () => ({ legal: true, extra: null, bat: 0, wicket: false }));
  const lastIdx = B - 1;
  // Wickets: an all-out innings ends on its 10th wicket; a won chase ends on a scoring shot.
  const wicketPool = Array.from({ length: B }, (_, i) => i).filter((i) => !(chaseWon && i === lastIdx) && !(plan.wickets === 10 && i === lastIdx));
  const wicketIdx = new Set(rng.sample(wicketPool.length, plan.wickets - (plan.wickets === 10 ? 1 : 0)).map((i) => wicketPool[i] as number));
  if (plan.wickets === 10 && B > 0) wicketIdx.add(lastIdx);
  for (const i of wicketIdx) (legal[i] as Slot).wicket = true;

  const free = legal.map((_, i) => i).filter((i) => !wicketIdx.has(i) && !(chaseWon && i === lastIdx));
  const extraIdx = rng.sample(free.length, Math.min(free.length, legByes + byes)).map((i) => free[i] as number);
  extraIdx.forEach((idx, n) => ((legal[idx] as Slot).extra = n < legByes ? 'lb' : 'b'));

  const scoring = free.filter((i) => !extraIdx.includes(i));
  const extrasRuns = wides + noBalls + legByes + byes;
  let lastRuns = 0;
  if (chaseWon && plan.target !== null) {
    const need = Math.max(1, plan.runs - (plan.target - 1));
    lastRuns = [1, 2, 3, 4, 6].find((v) => v >= need) ?? 6;
    (legal[lastIdx] as Slot).bat = lastRuns;
  }
  const batRuns = distribute(rng, scoring.length, plan.runs - extrasRuns - lastRuns);
  scoring.forEach((idx, n) => ((legal[idx] as Slot).bat = batRuns[n] as number));

  // Wides and no-balls go in before the final legal ball so they never extend a finished innings.
  const slots = [...legal];
  for (let i = 0; i < wides + noBalls; i += 1) {
    const at = rng.int(0, Math.max(0, slots.length - 1));
    slots.splice(at, 0, { legal: false, extra: i < wides ? 'wd' : 'nb', bat: 0, wicket: false });
  }
  return slots;
}

/** Overs → bowler: no consecutive overs, at most ceil(overs/5) each. */
function assignBowlers(rng: Rng, bowlers: SquadPlayer[], overs: number): SquadPlayer[] {
  const quota = Math.max(1, Math.ceil(overs / 5));
  const used = new Map<string, number>();
  const out: SquadPlayer[] = [];
  for (let o = 0; o < overs; o += 1) {
    const prev = out[o - 1]?.playerId;
    const options = bowlers.filter((b) => b.playerId !== prev && (used.get(b.playerId) ?? 0) < quota);
    const pool = options.length > 0 ? options : bowlers.filter((b) => b.playerId !== prev);
    // The opening pair shares the first four overs, then the captain mixes it up.
    const pick = o < 4 ? (pool[0] as SquadPlayer) : rng.pick(pool);
    used.set(pick.playerId, (used.get(pick.playerId) ?? 0) + 1);
    out.push(pick);
  }
  return out;
}

export interface SynthesizedMatch {
  innings: [BallEvent[], BallEvent[]];
  elevens: Record<string, SquadPlayer[]>;
}

function synthInnings(rng: Rng, script: ReplayScript, inningsNo: 1 | 2, plan: InningsPlan, elevens: Record<string, SquadPlayer[]>): BallEvent[] {
  const batting = elevens[plan.battingKey] ?? [];
  const fielding = elevens[plan.bowlingKey] ?? [];
  const bowlersByOver = assignBowlers(rng, pickBowlers(fielding), script.scheduledOvers);
  const keeper = fielding.find((p) => p.role === 'WK_BATTER') ?? fielding[0];
  const slots = planSlots(rng, plan);

  let striker = 0;
  let nonStriker = 1;
  let nextIn = 2;
  let runs = 0;
  let wickets = 0;
  let legalCount = 0;
  const out: BallEvent[] = [];

  slots.forEach((s, seqIdx) => {
    const over = Math.floor(legalCount / 6);
    const bowler = bowlersByOver[over] ?? bowlersByOver.at(-1) ?? fielding[0];
    if (!bowler) throw new Error(`no bowler available for ${plan.bowlingKey}`);
    const batter = batting[striker] as SquadPlayer;
    const partner = batting[nonStriker] as SquadPlayer;
    const extras = { wides: s.extra === 'wd' ? 1 : 0, noBalls: s.extra === 'nb' ? 1 : 0, byes: s.extra === 'b' ? 1 : 0, legByes: s.extra === 'lb' ? 1 : 0, penalty: 0 };
    const total = s.bat + extras.wides + extras.noBalls + extras.byes + extras.legByes;
    if (s.legal) legalCount += 1;
    runs += total;

    let wicket: BallEvent['wicket'] = null;
    if (s.wicket) {
      wickets += 1;
      const kind = rng.weighted(DISMISSALS);
      const runOutNonStriker = kind === 'RUN_OUT' && rng.chance(0.3);
      const outPlayer = runOutNonStriker ? partner : batter;
      const fielder = kind === 'STUMPED' ? keeper : kind === 'CAUGHT' && rng.chance(0.05) ? bowler : rng.pick(fielding);
      wicket = {
        kind,
        playerOutId: outPlayer.playerId,
        playerOutName: outPlayer.name,
        fielderName: kind === 'CAUGHT' || kind === 'RUN_OUT' || kind === 'STUMPED' ? (fielder?.name ?? null) : null,
      };
    }

    const event: BallEvent = {
      innings: inningsNo,
      over,
      ballInOver: Math.max(1, legalCount - over * 6),
      seq: seqIdx + 1,
      batterId: batter.playerId,
      batterName: batter.name,
      nonStrikerId: partner.playerId,
      bowlerId: bowler.playerId,
      bowlerName: bowler.name,
      runsBat: s.bat,
      extras,
      totalRuns: total,
      isLegal: s.legal,
      isBoundary: s.bat === 4 || s.bat === 6,
      wicket,
      commentary: '',
      scoreAfter: { runs, wickets, balls: legalCount },
      occurredAt: new Date(0),
    };
    event.commentary = commentaryFor(rng, event);
    out.push(event);

    if (wicket) {
      const outIsStriker = wicket.playerOutId === batter.playerId;
      if (nextIn < batting.length) {
        if (outIsStriker) striker = nextIn;
        else nonStriker = nextIn;
        nextIn += 1;
      }
    }
    const ran = s.bat + extras.byes + extras.legByes;
    if (ran % 2 === 1) [striker, nonStriker] = [nonStriker, striker];
    if (s.legal && legalCount % 6 === 0) [striker, nonStriker] = [nonStriker, striker];
  });
  return out;
}

const memo = new Map<string, SynthesizedMatch>();

/** Deterministic full ball-by-ball for a script. Same (script, seed) → identical match. */
export function synthesizeMatch(script: ReplayScript, seed: string): SynthesizedMatch {
  const key = `${script.id}:${seed}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const rng = Rng.fromString(key);
  const elevens = Object.fromEntries(script.teams.map((t) => [t.key, pickEleven(t, script.squads[t.key] ?? [])]));
  const result: SynthesizedMatch = {
    innings: [synthInnings(rng, script, 1, script.plan[0], elevens), synthInnings(rng, script, 2, script.plan[1], elevens)],
    elevens,
  };
  if (memo.size > 200) memo.clear();
  memo.set(key, result);
  return result;
}
