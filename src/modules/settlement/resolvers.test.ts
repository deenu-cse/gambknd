import { describe, expect, it } from 'vitest';
import currentMatches from '../../providers/cricket/fixtures/currentMatches.json' with { type: 'json' };
import { rawMatchSchema } from '../../providers/cricket/live/schemas.js';
import { normalizeMatch } from '../../providers/cricket/normalizers/match.js';
import { replayScripts } from '../../providers/cricket/replay/scripts.js';
import { timelineFor, type ReplaySession } from '../../providers/cricket/replay/sessions.js';
import { viewAt } from '../../providers/cricket/replay/state.js';
import { synthesizeMatch } from '../../providers/cricket/replay/synthesizer.js';
import type { BallEvent, ProviderMatch } from '../../providers/cricket/types.js';
import type { IMarket } from '../markets/market.model.js';
import type { IMatch } from '../matches/match.model.js';
import { completedNaturally, resolveMarket } from './resolvers.js';

type M = Pick<IMatch, 'status' | 'result' | 'toss' | 'innings' | 'scheduledOvers' | 'teams' | 'format'>;
type Mk = Pick<IMarket, 'type' | 'params' | 'lineX10' | 'selections'>;

const sel = (...ids: string[]) => ids.map((id) => ({ id, name: id, teamKey: null, playerId: null, odds: 200, probabilityBps: 0, status: 'ACTIVE' as const }));
const mk = (type: Mk['type'], params: Mk['params'] = {}, lineX10: number | null = null, ids: string[] = ['over', 'under']): Mk => ({ type, params, lineX10, selections: sel(...ids) });

/** A real capture, as a finished match. */
function real(i: number): M {
  const m = normalizeMatch(rawMatchSchema.parse(currentMatches[i]))!;
  return { status: m.status, result: m.result, toss: m.toss, innings: m.innings, scheduledOvers: m.scheduledOvers, teams: m.teams, format: m.format };
}

/** A replayed match at the end, with full ball-by-ball and scorecards. */
function replayed(scriptPrefix: string): { match: M; balls: BallEvent[]; pm: ProviderMatch } {
  const script = replayScripts().find((s) => s.id.startsWith(scriptPrefix))!;
  const synth = synthesizeMatch(script, 'resolver-test');
  const steps = timelineFor(script, synth, 'resolver-test');
  const session = { id: 'x', providerId: 'replay-x', scriptId: script.id, seed: 'resolver-test', status: 'finished', pauseReason: null, abandoned: false, outage: false, intervalMs: 1000, cursor: steps.length - 1, nextStepAt: 0, startAt: 0, createdAt: 0, finishedAt: 0 } satisfies ReplaySession;
  const { match: pm, balls } = viewAt({ session, script, synth, steps });
  return { pm, balls, match: { status: pm.status, result: pm.result, toss: pm.toss, innings: pm.innings, scheduledOvers: pm.scheduledOvers, teams: pm.teams, format: pm.format } };
}

describe('match winner & toss (real captures)', () => {
  it('settles on the stated winner, including a DLS win with fewer runs', () => {
    expect(resolveMarket(mk('MATCH_WINNER', {}, null, ['bulgaria-women', 'sweden-women']), real(0), [])).toMatchObject({ winningSelectionIds: ['sweden-women'], isVoid: false });
    const dls = real(2); // Austria W 37/0 beat Bulgaria W 39/8 under DLS
    expect(resolveMarket(mk('MATCH_WINNER', {}, null, ['austria-women', 'bulgaria-women']), dls, [])!.winningSelectionIds).toEqual(['austria-women']);
  });
  it('voids abandoned, no-result and plain ties; waits while in progress', () => {
    const base = real(0);
    for (const type of ['ABANDONED', 'NO_RESULT'] as const) {
      const m = { ...base, status: type, result: { type, winnerKey: null, margin: null, method: null, superOver: false, confident: true } };
      expect(resolveMarket(mk('MATCH_WINNER'), m, [])?.isVoid).toBe(true);
    }
    const tie = { ...base, result: { type: 'TIE' as const, winnerKey: null, margin: null, method: null, superOver: false, confident: true } };
    expect(resolveMarket(mk('MATCH_WINNER'), tie, [])?.isVoid).toBe(true);
    expect(resolveMarket(mk('MATCH_WINNER'), { ...base, status: 'LIVE' }, [])).toBeNull();
  });
  it('sends unmapped winners to manual settlement', () => {
    const m = { ...real(0), result: { type: 'WIN' as const, winnerKey: null, margin: null, method: null, superOver: false, confident: false } };
    expect(resolveMarket(mk('MATCH_WINNER'), m, [])).toBeNull();
  });
  it('toss: winner when known, void if it never happened', () => {
    const m = real(0);
    expect(resolveMarket(mk('TOSS_WINNER'), { ...m, toss: { winnerKey: 'sweden-women', decision: 'BOWL' } }, [])!.winningSelectionIds).toEqual(['sweden-women']);
    expect(resolveMarket(mk('TOSS_WINNER'), { ...m, toss: null }, [])?.isVoid).toBe(true);
  });
});

describe('innings totals (real captures)', () => {
  it('settles completed innings on the line', () => {
    const m = real(0); // Bulgaria W 98/9 (20), Sweden W 99/0 (5.5) chase won
    expect(resolveMarket(mk('INNINGS_TOTAL', { innings: 1 }, 955), m, [])!.winningSelectionIds).toEqual(['over']);
    expect(resolveMarket(mk('INNINGS_TOTAL', { innings: 1 }, 1005), m, [])!.winningSelectionIds).toEqual(['under']);
    expect(resolveMarket(mk('INNINGS_TOTAL', { innings: 2 }, 905), m, [])).toMatchObject({ winningSelectionIds: ['over'], settledValue: 99 });
  });
  it('voids a rain-shortened innings unless the line was already passed', () => {
    const m = real(2); // Bulgaria W 39/8 in 12 of 20 overs (DLS reduced)
    expect(completedNaturally(m.innings[0]!, m)).toBe(false);
    expect(resolveMarket(mk('INNINGS_TOTAL', { innings: 1 }, 605), m, [])?.isVoid).toBe(true);
    expect(resolveMarket(mk('INNINGS_TOTAL', { innings: 1 }, 305), m, [])!.winningSelectionIds).toEqual(['over']);
  });
  it('recognises reduced-overs games as complete', () => {
    const m = real(3); // "- 15 overs game": Romania W 75/5 in 15
    expect(completedNaturally(m.innings[0]!, m)).toBe(true);
    expect(resolveMarket(mk('INNINGS_TOTAL', { innings: 1 }, 705), m, [])!.winningSelectionIds).toEqual(['over']);
  });
});

describe('ball-level markets (replayed from real totals)', () => {
  const { match, balls } = replayed('2nd-match');
  const inn1 = match.innings[0]!;

  it('session: score at the end of the over', () => {
    const at36 = balls.find((b) => b.innings === 1 && b.isLegal && b.scoreAfter.balls === 36)!.scoreAfter.runs;
    expect(resolveMarket(mk('SESSION_RUNS', { innings: 1, overs: 6 }, at36 * 10 - 5, ['yes', 'no']), match, balls)).toMatchObject({ winningSelectionIds: ['yes'], settledValue: at36 });
    expect(resolveMarket(mk('SESSION_RUNS', { innings: 1, overs: 6 }, at36 * 10 + 5, ['yes', 'no']), match, balls)!.winningSelectionIds).toEqual(['no']);
  });
  it('session beyond an innings that ended naturally uses the final total', () => {
    const chase = match.innings[1]!; // Sweden W won in 5.5 overs
    expect(resolveMarket(mk('SESSION_RUNS', { innings: 2, overs: 10 }, 905, ['yes', 'no']), match, balls)).toMatchObject({ winningSelectionIds: ['yes'], settledValue: chase.runs });
  });
  it('next over: all runs of that over including extras', () => {
    const runs = balls.filter((b) => b.innings === 1 && b.over === 4).reduce((s, b) => s + b.totalRuns, 0);
    expect(resolveMarket(mk('NEXT_OVER_RUNS', { innings: 1, over: 4 }, runs * 10 - 5), match, balls)).toMatchObject({ winningSelectionIds: ['over'], settledValue: runs });
  });
  it('fall of wicket and dismissal method', () => {
    const fow = inn1.fallOfWickets[0]!;
    expect(resolveMarket(mk('FALL_OF_NEXT_WICKET', { innings: 1, wicket: 1 }, fow.runs * 10 + 5), match, balls)).toMatchObject({ winningSelectionIds: ['under'], settledValue: fow.runs });
    const kind = balls.find((b) => b.innings === 1 && b.wicket && b.scoreAfter.wickets === 1)!.wicket!.kind;
    const expected = kind === 'STUMPED' || kind === 'HIT_WICKET' ? 'OTHER' : kind;
    expect(resolveMarket(mk('DISMISSAL_METHOD', { innings: 1, wicket: 1 }, null, ['CAUGHT', 'BOWLED', 'LBW', 'RUN_OUT', 'OTHER']), match, balls)!.winningSelectionIds).toEqual([expected]);
    // Bulgaria W lost 9 wickets: the 10th never fell, innings complete → final total counts.
    expect(resolveMarket(mk('FALL_OF_NEXT_WICKET', { innings: 1, wicket: 10 }, 905), match, balls)).toMatchObject({ winningSelectionIds: ['over'], settledValue: 98 });
    expect(resolveMarket(mk('DISMISSAL_METHOD', { innings: 1, wicket: 10 }, null, ['CAUGHT']), match, balls)?.isVoid).toBe(true);
  });
  it('player runs settle on the batter’s final score', () => {
    const b = inn1.batting[0]!;
    expect(resolveMarket(mk('PLAYER_RUNS', { innings: 1, playerId: b.playerId }, b.runs * 10 + 5), match, balls)).toMatchObject({ winningSelectionIds: ['under'], settledValue: b.runs });
  });
  it('top batsman / bowler pick leaders and void non-participants', () => {
    const team = inn1.battingTeamKey;
    const top = Math.max(...inn1.batting.map((b) => b.runs));
    const leaders = inn1.batting.filter((b) => b.runs === top).map((b) => b.playerId);
    const market = mk('TOP_BATSMAN', { teamKey: team }, null, [...inn1.batting.map((b) => b.playerId), 'never-played']);
    const r = resolveMarket(market, match, balls)!;
    expect(r.winningSelectionIds.sort()).toEqual(leaders.sort());
    expect(r.deadHeatWays).toBe(leaders.length);
    expect(r.voidSelectionIds).toContain('never-played');
    const bowling = mk('TOP_BOWLER', { teamKey: inn1.bowlingTeamKey }, null, inn1.bowling.map((b) => b.playerId));
    expect(resolveMarket(bowling, match, balls)!.winningSelectionIds.length).toBeGreaterThanOrEqual(1);
  });
  it('opening partnership compares first-wicket stands', () => {
    const r = resolveMarket(mk('OPENING_PARTNERSHIP', {}, null, match.teams.map((t) => t.key)), match, balls)!;
    // Sweden W chased 99 without losing a wicket: their unbroken stand beats Bulgaria W's.
    expect(r.winningSelectionIds).toEqual(['sweden-women']);
  });
  it('waits while undecided', () => {
    const live = { ...match, status: 'LIVE' as const, innings: [{ ...inn1, isComplete: false, balls: 20, runs: 10, fallOfWickets: [] }] };
    expect(resolveMarket(mk('INNINGS_TOTAL', { innings: 1 }, 905), live, balls)).toBeNull();
    expect(resolveMarket(mk('TOP_BATSMAN', { teamKey: inn1.battingTeamKey }), live, balls)).toBeNull();
  });
});
