import { describe, expect, it } from 'vitest';
import cricScore from '../fixtures/cricScore.json' with { type: 'json' };
import currentMatches from '../fixtures/currentMatches.json' with { type: 'json' };
import fixtures from '../fixtures/matches.json' with { type: 'json' };
import playerInfo from '../fixtures/playerInfo.json' with { type: 'json' };
import series from '../fixtures/series.json' with { type: 'json' };
import seriesSquad from '../fixtures/seriesSquad.json' with { type: 'json' };
import { rawCricScoreSchema, rawMatchSchema, rawPlayerInfoSchema, rawSeriesSchema, rawSquadSchema } from '../live/schemas.js';
import type { TeamRef } from '../types.js';
import { buildTeamRef, normalizeCricScore, normalizeMatch } from './match.js';
import { normalizePlayerInfo, normalizeSquad, pivotStats } from './player.js';
import { dismissalKindOf, normalizeBalls } from './scorecard.js';
import { normalizeSeries } from './series.js';
import { deriveMatchStatus, parseResultText, parseTossText } from './status.js';
import { ballsToOvers, cleanImage, inferFormat, normalizeTeamKey, oversToBalls, parseGmt } from './text.js';

const match = (i: number) => {
  const m = normalizeMatch(rawMatchSchema.parse(currentMatches[i]));
  if (!m) throw new Error('fixture did not normalize');
  return m;
};

describe('text helpers', () => {
  it('reads overs as balls, not decimals', () => {
    expect(oversToBalls(5.5)).toBe(35);
    expect(oversToBalls(13.3)).toBe(81);
    expect(oversToBalls(20)).toBe(120);
    expect(ballsToOvers(81)).toBe('13.3');
  });
  it('normalizes team keys across spellings', () => {
    expect(normalizeTeamKey('bulgaria women')).toBe(normalizeTeamKey('Bulgaria Women'));
    expect(normalizeTeamKey('Gambia [GAM]')).toBe('gambia');
  });
  it('drops placeholder images', () => {
    expect(cleanImage('https://h.cricapi.com/img/icon512.png')).toBeNull();
    expect(cleanImage('https://g.cricapi.com/iapi/1.webp?w=48')).toMatch(/^https/);
  });
  it('infers format beyond the unreliable matchType', () => {
    expect(inferFormat('t20', 'X vs Y, Final, Abu Dhabi T10 League 2026')).toBe('T10');
    expect(inferFormat('', 'Zimbabwe Women tour of India, 2026')).toBe('T20');
    expect(inferFormat('odi')).toBe('ODI');
  });
  it('parses GMT times and flags unknown midnight times', () => {
    expect(parseGmt('2026-10-16T11:00:00')).toEqual({ date: new Date('2026-10-16T11:00:00Z'), confirmed: true });
    expect(parseGmt('2026-10-15T00:00:00').confirmed).toBe(false);
  });
});

describe('normalizeMatch on real captures', () => {
  it('resolves the chasing team from "A,B Inning 1" labels', () => {
    const m = match(0); // Bulgaria W 98/9, then "Bulgaria Women,Sweden Women Inning 1" 99/0
    expect(m.innings.map((i) => [i.battingTeamKey, i.runs, i.wickets, i.balls])).toEqual([
      ['bulgaria-women', 98, 9, 120],
      ['sweden-women', 99, 0, 35],
    ]);
    expect(m.innings[1]?.target).toBe(99);
    expect(m.status).toBe('COMPLETED');
    expect(m.result).toMatchObject({ type: 'WIN', winnerKey: 'sweden-women', margin: { value: 10, unit: 'WICKETS' }, confident: true });
    expect(m.venue).toEqual({ name: 'Moara Vlasiei Cricket Ground', city: 'Bucharest' });
    expect(m.matchLabel).toBe('2nd Match');
    expect(m.teams[0].logoUrl).toBeNull(); // placeholder image
  });

  it('handles the label where the batting side is listed first', () => {
    const m = match(2); // "Austria Women,Bulgaria Women Inning 1" — Austria chased
    expect(m.innings[1]?.battingTeamKey).toBe('austria-women');
    // DLS: the winner scored fewer runs; never infer the winner from runs.
    expect(m.innings[1]!.runs).toBeLessThan(m.innings[0]!.runs);
    expect(m.result).toMatchObject({ winnerKey: 'austria-women', method: 'DLS' });
  });

  it('reads reduced-overs games and joins teamInfo by name, not position', () => {
    const m = match(3); // teams [Romania, Bulgaria], teamInfo [Bulgaria, Romania]
    expect(m.scheduledOvers).toBe(15);
    expect(m.teams.map((t) => [t.key, t.shortName])).toEqual([['romania-women', 'RW'], ['bulgaria-women', 'BW']]);
    expect(m.innings[1]?.battingTeamKey).toBe('bulgaria-women');
  });

  it('normalizes upcoming fixtures, including franchise teams without shortnames', () => {
    const all = fixtures.map((f) => normalizeMatch(rawMatchSchema.parse(f)));
    const eagles = all[1];
    expect(eagles).toMatchObject({ status: 'UPCOMING', format: 'T10', scheduledOvers: 10, innings: [] });
    expect(eagles?.teams[0].shortName).toBe('EE');
  });

  it('turns cricScore rows into change-detector ticks', () => {
    const ticks = cricScore.map((r) => normalizeCricScore(rawCricScoreSchema.parse(r)));
    expect(ticks).toHaveLength(cricScore.length);
    expect(ticks[0]).toMatchObject({ providerId: 'b12481b9-3c03-4a66-836f-0d87019d63ab', phase: 'fixture' });
  });
});

describe('status & result parsing', () => {
  const teams: TeamRef[] = [buildTeamRef('India'), buildTeamRef('New Zealand', 'NZ')];
  it.each([
    ['India won by 58 runs', { type: 'WIN', winnerKey: 'india', margin: { value: 58, unit: 'RUNS' } }],
    ['New Zealand won by an innings and 12 runs', { type: 'WIN', winnerKey: 'new-zealand', margin: { value: 12, unit: 'RUNS' } }],
    ['Match tied (New Zealand won the Super Over)', { type: 'WIN', winnerKey: 'new-zealand', superOver: true }],
    ['Match tied', { type: 'TIE', winnerKey: null }],
    ['No result', { type: 'NO_RESULT' }],
    ['Match abandoned due to rain', { type: 'ABANDONED' }],
    ['Match drawn', { type: 'DRAW' }],
  ])('%s', (text, expected) => {
    expect(parseResultText(text, teams)).toMatchObject(expected);
  });

  it('marks unknown winners as not confident (manual settlement)', () => {
    expect(parseResultText('Mystery XI won by 3 wkts', teams)).toMatchObject({ winnerKey: null, confident: false });
  });

  it('parses toss lines', () => {
    expect(parseTossText('New Zealand opt to bowl', teams)).toEqual({ winnerKey: 'new-zealand', decision: 'BOWL' });
    expect(parseTossText('India won the toss and elected to bat', teams)).toEqual({ winnerKey: 'india', decision: 'BAT' });
  });

  it('derives in-play statuses', () => {
    const base = { matchStarted: true, matchEnded: false, hasScore: true };
    expect(deriveMatchStatus({ ...base, statusText: 'India need 20 runs in 15 balls' })).toBe('LIVE');
    expect(deriveMatchStatus({ ...base, statusText: 'Rain stops play' })).toBe('RAIN_DELAY');
    expect(deriveMatchStatus({ ...base, statusText: 'Innings Break' })).toBe('INNINGS_BREAK');
    expect(deriveMatchStatus({ ...base, hasScore: false, matchStarted: false, statusText: 'India opt to bat' })).toBe('TOSS');
    expect(deriveMatchStatus({ matchStarted: false, matchEnded: false, hasScore: false, statusText: 'Match starts at Oct 23, 13:00 GMT' })).toBe('UPCOMING');
  });
});

describe('series, squads, players', () => {
  it('flags shadow duplicate series and infers years', () => {
    const all = series.map((s) => normalizeSeries(rawSeriesSchema.parse(s)));
    const real = all.find((s) => s.providerId === '4a708cd9-0b6e-4315-94cc-c665beaa4acd');
    const shadow = all.find((s) => s.providerId === 'eb59e02f-5f61-40c9-9f88-5824445e62b5');
    expect(real?.isShadow).toBe(false);
    expect(shadow?.isShadow).toBe(true);
    const wc = all[0];
    expect(wc?.startDate?.toISOString()).toBe('2027-10-02T00:00:00.000Z');
    expect(wc?.endDate?.toISOString()).toBe('2027-11-21T00:00:00.000Z');
  });

  it('normalizes squads with missing roles and styles', () => {
    const squads = seriesSquad.map((s) => normalizeSquad(rawSquadSchema.parse(s)));
    const bahrain = squads[0];
    expect(bahrain?.team.key).toBe('bahrain');
    expect(bahrain?.players.find((p) => p.name === 'Amaish Rana')).toMatchObject({ role: 'UNKNOWN', battingStyle: null, imageUrl: null });
    expect(bahrain?.players.find((p) => p.name === 'Junaid Aziz')).toMatchObject({ role: 'BOWLER', bowlingType: 'SPIN' });
    expect(bahrain?.players.find((p) => p.name === 'Sohail Ahmed')?.bowlingType).toBe('PACE');
  });

  it('pivots padded EAV stats into integer stats', () => {
    const p = normalizePlayerInfo(rawPlayerInfoSchema.parse(playerInfo));
    expect(p).toMatchObject({ name: 'Srishti Raha', role: 'WK_BATTER', battingStyle: 'RHB', placeOfBirth: null });
    expect(p.stats.batting.T20).toMatchObject({ matches: 0, runs: 0, average100: 0 });
    expect(p.stats.bowling.ODI?.bestInnings).toBeNull();
    const pivot = pivotStats([
      { fn: 'batting', matchtype: 't20', stat: ' avg ', value: ' 27.45 ' },
      { fn: 'batting', matchtype: 't20', stat: ' hs ', value: ' 88* ' },
      { fn: 'bowling', matchtype: 't20', stat: ' bbi ', value: ' 4/21 ' },
    ]);
    expect(pivot.batting.T20).toMatchObject({ average100: 2745, highScore: 88, highScoreNotOut: true });
    expect(pivot.bowling.T20?.bestInnings).toEqual({ wickets: 4, runs: 21 });
  });
});

describe('dismissal wording', () => {
  it('reads the words a real scorecard uses', () => {
    expect(dismissalKindOf('catch')).toBe('CAUGHT');
    expect(dismissalKindOf('c Karim Janat b Nangeyalia Kharoti')).toBe('CAUGHT');
    expect(dismissalKindOf('retired out')).toBe('OTHER');
  });
});

describe('ball-by-ball (assumed match_bbb shape, A-16)', () => {
  it('recomputes legal counts, score and crease', () => {
    const ref = (id: string) => ({ id, name: id.toUpperCase() });
    const balls = normalizeBalls([
      { n: 1, inning: 0, over: 0, ball: 1, batsman: ref('a'), bowler: ref('x'), runs: 4, extras: 0 },
      { n: 2, inning: 0, over: 0, ball: 2, batsman: ref('a'), bowler: ref('x'), runs: 0, extras: 1, extrasType: 'wd' },
      { n: 3, inning: 0, over: 0, ball: 2, batsman: ref('a'), bowler: ref('x'), runs: 1, extras: 0 },
      { n: 4, inning: 0, over: 0, ball: 3, batsman: ref('b'), bowler: ref('x'), runs: 0, extras: 0, dismissal: 'c Y b X', catcher: ref('y') },
    ]);
    expect(balls.map((b) => [b.innings, b.over, b.ballInOver, b.isLegal])).toEqual([[1, 0, 1, true], [1, 0, 1, false], [1, 0, 2, true], [1, 0, 3, true]]);
    expect(balls.at(-1)).toMatchObject({ scoreAfter: { runs: 6, wickets: 1, balls: 3 }, wicket: { kind: 'CAUGHT', playerOutId: 'b', fielderName: 'Y' } });
    expect(balls[0]?.isBoundary).toBe(true);
  });
});
