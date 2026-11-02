import { describe, expect, it } from 'vitest';
import { ballCode, deriveCrease, deriveInnings } from './derive.js';
import type { BallEvent } from './types.js';

let seq = 0;
function ball(over: number, ballInOver: number, p: Partial<BallEvent> = {}): BallEvent {
  seq += 1;
  const extras = { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0, ...(p.extras ?? {}) };
  const runsBat = p.runsBat ?? 0;
  return {
    innings: 1, over, ballInOver, seq,
    batterId: 'A', batterName: 'Asha', nonStrikerId: 'B', bowlerId: 'X', bowlerName: 'Xena',
    runsBat, extras, totalRuns: runsBat + extras.wides + extras.noBalls + extras.byes + extras.legByes,
    isLegal: extras.wides === 0 && extras.noBalls === 0, isBoundary: runsBat === 4 || runsBat === 6,
    wicket: null, commentary: '', scoreAfter: { runs: 0, wickets: 0, balls: 0 }, occurredAt: new Date(0),
    ...p,
    ...(p.extras ? { extras } : {}),
  };
}

describe('deriveCrease', () => {
  it('swaps strike on a single', () => {
    const c = deriveCrease([ball(0, 1, { runsBat: 1 })]);
    expect([c.strikerId, c.nonStrikerId]).toEqual(['B', 'A']);
  });

  it('swaps strike at the end of the over', () => {
    const c = deriveCrease([ball(0, 6, { runsBat: 0 })]);
    expect([c.strikerId, c.nonStrikerId, c.bowlerId]).toEqual(['B', 'A', null]);
  });

  it('leaves the dismissed slot empty until the next batter faces', () => {
    const c = deriveCrease([ball(0, 1, { runsBat: 4 }), ball(0, 2, { wicket: { kind: 'BOWLED', playerOutId: 'A', playerOutName: 'Asha', fielderName: null } })]);
    expect([c.strikerId, c.nonStrikerId]).toEqual([null, 'B']);
    expect(c.partnership).toEqual({ runs: 0, balls: 0 });
    expect(c.lastSixBalls).toEqual(['4', 'W']);
  });

  it('counts a partnership since the last wicket', () => {
    const c = deriveCrease([
      ball(0, 1, { wicket: { kind: 'LBW', playerOutId: 'A', playerOutName: 'Asha', fielderName: null } }),
      ball(0, 2, { batterId: 'C', runsBat: 2 }),
      ball(0, 2, { batterId: 'C', extras: { wides: 1, noBalls: 0, byes: 0, legByes: 0, penalty: 0 } }),
    ]);
    expect(c.partnership).toEqual({ runs: 3, balls: 1 });
  });
});

describe('deriveInnings', () => {
  it('charges bowlers correctly and credits wickets except run outs', () => {
    const d = deriveInnings([
      ball(0, 1, { runsBat: 4 }),
      ball(0, 1, { extras: { wides: 1, noBalls: 0, byes: 0, legByes: 0, penalty: 0 } }),
      ball(0, 2, { extras: { wides: 0, noBalls: 0, byes: 0, legByes: 2, penalty: 0 } }),
      ball(0, 3, { wicket: { kind: 'RUN_OUT', playerOutId: 'B', playerOutName: 'Bo', fielderName: 'Fi' } }),
      ball(0, 4, { batterId: 'A', nonStrikerId: 'C', wicket: { kind: 'CAUGHT', playerOutId: 'A', playerOutName: 'Asha', fielderName: 'Fi' } }),
    ]);
    expect([d.runs, d.wickets, d.balls]).toEqual([7, 2, 4]);
    expect(d.bowling[0]).toMatchObject({ runs: 5, wickets: 1, balls: 4, wides: 1 });
    expect(d.extras).toMatchObject({ wides: 1, legByes: 2, total: 3 });
    expect(d.batting.find((b) => b.playerId === 'A')).toMatchObject({ runs: 4, balls: 4, fours: 1, isOut: true, dismissal: 'c Fi b Xena' });
    expect(d.fallOfWickets.map((f) => [f.wicket, f.runs])).toEqual([[1, 7], [2, 7]]);
  });

  it('codes the recent-balls strip', () => {
    expect(ballCode(ball(0, 1, { runsBat: 0 }))).toBe('•');
    expect(ballCode(ball(0, 1, { runsBat: 6 }))).toBe('6');
    expect(ballCode(ball(0, 1, { extras: { wides: 1, noBalls: 0, byes: 0, legByes: 0, penalty: 0 } }))).toBe('wd');
  });
});
