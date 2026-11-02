import type { BallEvent, BatterLine, BowlerLine, Extras, FallOfWicket } from './types.js';

export interface DerivedInnings {
  runs: number;
  wickets: number;
  balls: number;
  extras: Extras;
  batting: BatterLine[];
  bowling: BowlerLine[];
  fallOfWickets: FallOfWicket[];
}

export function dismissalText(ball: BallEvent): string | null {
  const w = ball.wicket;
  if (!w) return null;
  const f = w.fielderName ?? 'sub';
  switch (w.kind) {
    case 'CAUGHT':
      return w.fielderName === ball.bowlerName ? `c & b ${ball.bowlerName}` : `c ${f} b ${ball.bowlerName}`;
    case 'BOWLED':
      return `b ${ball.bowlerName}`;
    case 'LBW':
      return `lbw b ${ball.bowlerName}`;
    case 'RUN_OUT':
      return `run out (${f})`;
    case 'STUMPED':
      return `st ${f} b ${ball.bowlerName}`;
    case 'HIT_WICKET':
      return `hit wicket b ${ball.bowlerName}`;
    default:
      return 'out';
  }
}

/** Bowler is credited with the wicket for everything except run outs (and "other"). */
export function bowlerCredited(ball: BallEvent): boolean {
  return !!ball.wicket && ball.wicket.kind !== 'RUN_OUT' && ball.wicket.kind !== 'OTHER';
}

/** Runs charged to the bowler: bat runs + wides + no-balls (not byes / leg-byes). */
export function bowlerRuns(ball: BallEvent): number {
  return ball.runsBat + ball.extras.wides + ball.extras.noBalls;
}

/** Builds a full scorecard for one innings from its deliveries (in seq order). */
export function deriveInnings(balls: readonly BallEvent[], names: ReadonlyMap<string, string> = new Map()): DerivedInnings {
  const batting = new Map<string, BatterLine>();
  const bowling = new Map<string, BowlerLine>();
  const overRuns = new Map<string, { bowler: string; legal: number; runs: number }>();
  const extras: Extras = { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0, total: 0 };
  const fow: FallOfWicket[] = [];
  let runs = 0;
  let wickets = 0;
  let legal = 0;

  const batter = (id: string, name: string): BatterLine => {
    let line = batting.get(id);
    if (!line) {
      line = { playerId: id, name: names.get(id) ?? name, runs: 0, balls: 0, fours: 0, sixes: 0, dismissal: null, isOut: false };
      batting.set(id, line);
    }
    return line;
  };

  for (const b of balls) {
    const striker = batter(b.batterId, b.batterName);
    batter(b.nonStrikerId, names.get(b.nonStrikerId) ?? b.nonStrikerId);
    const bowler = bowling.get(b.bowlerId) ?? { playerId: b.bowlerId, name: b.bowlerName, balls: 0, maidens: 0, runs: 0, wickets: 0, wides: 0, noBalls: 0 };
    bowling.set(b.bowlerId, bowler);

    if (b.extras.wides === 0) striker.balls += 1;
    striker.runs += b.runsBat;
    if (b.isBoundary && b.runsBat === 4) striker.fours += 1;
    if (b.isBoundary && b.runsBat === 6) striker.sixes += 1;

    bowler.runs += bowlerRuns(b);
    if (b.isLegal) bowler.balls += 1;
    if (b.extras.wides > 0) bowler.wides += b.extras.wides;
    if (b.extras.noBalls > 0) bowler.noBalls += b.extras.noBalls;

    const overKey = `${b.over}`;
    const o = overRuns.get(overKey) ?? { bowler: b.bowlerId, legal: 0, runs: 0 };
    o.runs += bowlerRuns(b);
    if (b.isLegal) o.legal += 1;
    overRuns.set(overKey, o);

    extras.wides += b.extras.wides;
    extras.noBalls += b.extras.noBalls;
    extras.byes += b.extras.byes;
    extras.legByes += b.extras.legByes;
    extras.penalty += b.extras.penalty;

    runs += b.totalRuns;
    if (b.isLegal) legal += 1;

    if (b.wicket) {
      wickets += 1;
      const out = batter(b.wicket.playerOutId, b.wicket.playerOutName);
      out.isOut = true;
      out.dismissal = dismissalText(b);
      if (bowlerCredited(b)) bowler.wickets += 1;
      fow.push({ wicket: wickets, runs, balls: legal, playerId: b.wicket.playerOutId, playerName: b.wicket.playerOutName });
    }
  }

  for (const o of overRuns.values()) {
    if (o.legal === 6 && o.runs === 0) {
      const bw = bowling.get(o.bowler);
      if (bw) bw.maidens += 1;
    }
  }
  extras.total = extras.wides + extras.noBalls + extras.byes + extras.legByes + extras.penalty;
  return { runs, wickets, balls: legal, extras, batting: [...batting.values()], bowling: [...bowling.values()], fallOfWickets: fow };
}

/** Compact code for the "last 6 balls" chips: "•", "1", "4", "6", "W", "wd", "nb", "1lb", "2b". */
export function ballCode(b: BallEvent): string {
  if (b.wicket) return 'W';
  if (b.extras.wides > 0) return b.extras.wides > 1 ? `${b.extras.wides}wd` : 'wd';
  if (b.extras.noBalls > 0) return b.runsBat > 0 ? `nb+${b.runsBat}` : 'nb';
  if (b.extras.legByes > 0) return `${b.extras.legByes}lb`;
  if (b.extras.byes > 0) return `${b.extras.byes}b`;
  return b.runsBat === 0 ? '•' : String(b.runsBat);
}

export interface LiveCrease {
  strikerId: string | null;
  nonStrikerId: string | null;
  bowlerId: string | null;
  partnership: { runs: number; balls: number };
  lastSixBalls: string[];
  currentOverRuns: number;
}

/** Who is on strike *after* the last delivery, the current partnership and the recent-balls strip. */
export function deriveCrease(balls: readonly BallEvent[]): LiveCrease {
  const last = balls.at(-1);
  if (!last) return { strikerId: null, nonStrikerId: null, bowlerId: null, partnership: { runs: 0, balls: 0 }, lastSixBalls: [], currentOverRuns: 0 };

  let striker: string | null = last.batterId;
  let nonStriker: string | null = last.nonStrikerId;
  const ran = last.runsBat + last.extras.byes + last.extras.legByes + Math.max(0, last.extras.wides - 1);
  if (ran % 2 === 1) [striker, nonStriker] = [nonStriker, striker];
  if (last.wicket) {
    if (last.wicket.playerOutId === striker) striker = null;
    else if (last.wicket.playerOutId === nonStriker) nonStriker = null;
  }
  const overDone = last.isLegal && last.ballInOver === 6;
  if (overDone) [striker, nonStriker] = [nonStriker, striker];

  let pRuns = 0;
  let pBalls = 0;
  // The partnership is everything after the most recent wicket (0 right after a dismissal).
  for (let i = balls.length - 1; i >= 0; i -= 1) {
    const b = balls[i] as BallEvent;
    if (b.wicket) break;
    pRuns += b.totalRuns;
    if (b.isLegal) pBalls += 1;
  }

  const currentOver = overDone ? [] : balls.filter((b) => b.over === last.over);
  return {
    strikerId: striker,
    nonStrikerId: nonStriker,
    bowlerId: overDone ? null : last.bowlerId,
    partnership: { runs: pRuns, balls: pBalls },
    lastSixBalls: balls.slice(-6).map(ballCode),
    currentOverRuns: currentOver.reduce((s, b) => s + b.totalRuns, 0),
  };
}

/** Runs and wickets per over, for the worm and manhattan charts. */
export function perOver(balls: readonly BallEvent[]): Array<{ over: number; runs: number; wickets: number; cumulative: number }> {
  const out: Array<{ over: number; runs: number; wickets: number; cumulative: number }> = [];
  let cumulative = 0;
  for (const b of balls) {
    let row = out[out.length - 1];
    if (!row || row.over !== b.over + 1) {
      row = { over: b.over + 1, runs: 0, wickets: 0, cumulative };
      out.push(row);
    }
    row.runs += b.totalRuns;
    if (b.wicket) row.wickets += 1;
    cumulative += b.totalRuns;
    row.cumulative = cumulative;
  }
  return out;
}
