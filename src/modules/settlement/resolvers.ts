import { FINISHED_STATUSES, type BallEvent, type Innings } from '../../providers/cricket/types.js';
import type { MarketResult } from '../markets/market.model.js';
import type { IMarket } from '../markets/market.model.js';
import type { IMatch } from '../matches/match.model.js';

/**
 * Pure resolvers: (market, match, balls) → result, or null when the market can't be decided yet
 * (or needs a human). Every rule here is written down in docs/MARKET_RULES.md.
 */
export type Resolution = MarketResult;

type MatchFacts = Pick<IMatch, 'status' | 'result' | 'toss' | 'innings' | 'scheduledOvers' | 'teams' | 'format'>;
type MarketFacts = Pick<IMarket, 'type' | 'params' | 'lineX10' | 'selections'>;

const finished = (m: MatchFacts): boolean => FINISHED_STATUSES.includes(m.status);
const abandoned = (m: MatchFacts): boolean => m.status === 'ABANDONED' || m.status === 'NO_RESULT';

function win(ids: string[], settledValue: number | null = null, voidSelectionIds: string[] = []): Resolution {
  return { winningSelectionIds: ids, deadHeatWays: Math.max(1, ids.length), isVoid: false, reason: null, settledValue, voidSelectionIds };
}

export function voidResult(reason: string): Resolution {
  return { winningSelectionIds: [], deadHeatWays: 1, isVoid: true, reason, settledValue: null, voidSelectionIds: [] };
}

function overUnder(value: number, lineX10: number | null, ids: [string, string] = ['over', 'under']): Resolution | null {
  if (lineX10 === null) return null;
  return win([value * 10 > lineX10 ? ids[0] : ids[1]], value);
}

/** Did the innings end on its own (all out, overs used, chase won), rather than being cut short? */
export function completedNaturally(inn: Innings, m: MatchFacts): boolean {
  const allotted = inn.allottedBalls ?? (m.scheduledOvers ? m.scheduledOvers * 6 : null);
  return inn.wickets >= 10 || (allotted !== null && inn.balls >= allotted) || (inn.target !== null && inn.runs >= inn.target);
}

function inningsOf(m: MatchFacts, n: number): Innings | null {
  return m.innings.find((i) => i.number === n) ?? null;
}

const BUCKET: Record<string, string> = { CAUGHT: 'CAUGHT', BOWLED: 'BOWLED', LBW: 'LBW', RUN_OUT: 'RUN_OUT', STUMPED: 'OTHER', HIT_WICKET: 'OTHER', OTHER: 'OTHER' };

function resolveMatchWinner(market: MarketFacts, m: MatchFacts): Resolution | null {
  if (!finished(m)) return null;
  const r = m.result;
  if (!r) return null;
  if (r.type === 'ABANDONED' || r.type === 'NO_RESULT') return voidResult(`match ${r.type.toLowerCase().replace('_', ' ')}`);
  if (r.type === 'TIE') return voidResult('tie without a super over');
  if (r.type === 'DRAW') return market.selections.some((s) => s.id === 'draw') ? win(['draw']) : voidResult('match drawn');
  // A recognised result line whose winner we couldn't map stays for manual settlement (A-12).
  if (!r.confident || !r.winnerKey) return null;
  return win([r.winnerKey]);
}

function resolveInningsTotal(market: MarketFacts, m: MatchFacts): Resolution | null {
  const inn = inningsOf(m, market.params.innings ?? 1);
  if (inn && inn.isComplete && completedNaturally(inn, m)) return overUnder(inn.runs, market.lineX10);
  // Runs only go up: once the line is passed, Over has won, even if the innings is later cut short.
  if (inn && market.lineX10 !== null && inn.runs * 10 > market.lineX10) return overUnder(inn.runs, market.lineX10);
  return finished(m) ? voidResult('innings not completed') : null;
}

function resolveSession(market: MarketFacts, m: MatchFacts, balls: readonly BallEvent[]): Resolution | null {
  const n = market.params.innings ?? 1;
  const end = (market.params.overs ?? 0) * 6;
  const own = balls.filter((b) => b.innings === n);
  const atEnd = own.find((b) => b.isLegal && b.scoreAfter.balls === end);
  if (atEnd) return overUnder(atEnd.scoreAfter.runs, market.lineX10, ['yes', 'no']);
  const inn = inningsOf(m, n);
  if (inn?.isComplete && completedNaturally(inn, m)) return overUnder(inn.runs, market.lineX10, ['yes', 'no']);
  if (inn && market.lineX10 !== null && inn.runs * 10 > market.lineX10) return overUnder(inn.runs, market.lineX10, ['yes', 'no']);
  return finished(m) || inn?.isComplete ? voidResult('session overs not completed') : null;
}

function resolveNextOver(market: MarketFacts, m: MatchFacts, balls: readonly BallEvent[]): Resolution | null {
  const n = market.params.innings ?? 1;
  const over = market.params.over ?? 0;
  const inOver = balls.filter((b) => b.innings === n && b.over === over);
  const runs = inOver.reduce((s, b) => s + b.totalRuns, 0);
  if (inOver.filter((b) => b.isLegal).length >= 6) return overUnder(runs, market.lineX10);
  const inn = inningsOf(m, n);
  if (inn?.isComplete && completedNaturally(inn, m) && inOver.length > 0) return overUnder(runs, market.lineX10);
  return finished(m) || inn?.isComplete ? voidResult('over not completed') : null;
}

function resolveFallOfWicket(market: MarketFacts, m: MatchFacts): Resolution | null {
  const inn = inningsOf(m, market.params.innings ?? 1);
  const w = market.params.wicket ?? 1;
  const fow = inn?.fallOfWickets.find((f) => f.wicket === w);
  if (fow) return overUnder(fow.runs, market.lineX10);
  if (!inn) return finished(m) ? voidResult('innings not played') : null;
  // Wicket never fell: the innings' final total counts if it finished naturally.
  if (inn.isComplete && completedNaturally(inn, m)) return overUnder(inn.runs, market.lineX10);
  // The total at the fall can't be lower than the score now, so a passed line is already Over.
  if (market.lineX10 !== null && inn.runs * 10 > market.lineX10) return overUnder(inn.runs, market.lineX10);
  return inn.isComplete || finished(m) ? voidResult('innings cut short before the wicket') : null;
}

function resolveDismissal(market: MarketFacts, m: MatchFacts, balls: readonly BallEvent[]): Resolution | null {
  const n = market.params.innings ?? 1;
  const w = market.params.wicket ?? 1;
  const wicketBall = balls.filter((b) => b.innings === n && b.wicket).find((b) => b.scoreAfter.wickets === w);
  if (wicketBall?.wicket) return win([BUCKET[wicketBall.wicket.kind] ?? 'OTHER']);
  const inn = inningsOf(m, n);
  return inn?.isComplete || finished(m) ? voidResult('wicket did not fall') : null;
}

function resolvePlayerRuns(market: MarketFacts, m: MatchFacts): Resolution | null {
  const inn = inningsOf(m, market.params.innings ?? 1);
  const line = inn?.batting.find((b) => b.playerId === market.params.playerId);
  if (!inn || !line) return finished(m) ? voidResult('player did not bat') : null;
  if (line.isOut || (inn.isComplete && completedNaturally(inn, m))) return overUnder(line.runs, market.lineX10);
  if (market.lineX10 !== null && line.runs * 10 > market.lineX10) return overUnder(line.runs, market.lineX10);
  return inn.isComplete || finished(m) ? voidResult('innings cut short, player not out below the line') : null;
}

/** Top batsman/bowler: winners are tied leaders (dead heat). Non-participants are void selections. */
function resolveTopPlayer(market: MarketFacts, m: MatchFacts): Resolution | null {
  if (!finished(m)) return null;
  if (abandoned(m)) return voidResult('match abandoned');
  const team = market.params.teamKey;
  const batted = m.innings.filter((i) => i.battingTeamKey === team);
  const bowled = m.innings.filter((i) => i.bowlingTeamKey === team);
  const participants = new Set([...batted.flatMap((i) => i.batting.map((b) => b.playerId)), ...bowled.flatMap((i) => i.bowling.map((b) => b.playerId))]);
  const voidIds = market.selections.filter((s) => !participants.has(s.id)).map((s) => s.id);

  if (market.type === 'TOP_BATSMAN') {
    const runs = new Map<string, number>();
    for (const b of batted.flatMap((i) => i.batting)) runs.set(b.playerId, (runs.get(b.playerId) ?? 0) + b.runs);
    if (runs.size === 0) return voidResult('team did not bat');
    const best = Math.max(...runs.values());
    return win([...runs].filter(([, r]) => r === best).map(([id]) => id), best, voidIds);
  }
  const figs = new Map<string, { w: number; r: number }>();
  for (const b of bowled.flatMap((i) => i.bowling)) {
    const f = figs.get(b.playerId) ?? { w: 0, r: 0 };
    figs.set(b.playerId, { w: f.w + b.wickets, r: f.r + b.runs });
  }
  const maxW = Math.max(0, ...[...figs.values()].map((f) => f.w));
  if (maxW === 0) return voidResult('no wickets taken');
  const leaders = [...figs].filter(([, f]) => f.w === maxW);
  const minR = Math.min(...leaders.map(([, f]) => f.r));
  return win(leaders.filter(([, f]) => f.r === minR).map(([id]) => id), maxW, voidIds);
}

function openingStand(inn: Innings | null, m: MatchFacts): number | null {
  if (!inn) return null;
  const first = inn.fallOfWickets[0];
  if (first) return first.runs;
  return inn.isComplete && completedNaturally(inn, m) ? inn.runs : null;
}

function resolveOpening(_market: MarketFacts, m: MatchFacts): Resolution | null {
  const i1 = inningsOf(m, 1);
  const i2 = inningsOf(m, 2);
  const a = openingStand(i1, m);
  const b = openingStand(i2, m);
  // Decided early when the chasers' unbroken stand already beats the first one.
  if (a !== null && i2 && b === null && i2.runs > a && i2.fallOfWickets.length === 0) return win([i2.battingTeamKey], i2.runs);
  if (a === null || b === null || !i1 || !i2) return finished(m) ? voidResult('opening stands not completed') : null;
  if (a === b) return win([i1.battingTeamKey, i2.battingTeamKey], a);
  return win([a > b ? i1.battingTeamKey : i2.battingTeamKey], Math.max(a, b));
}

export function resolveMarket(market: MarketFacts, match: MatchFacts, balls: readonly BallEvent[]): Resolution | null {
  switch (market.type) {
    case 'MATCH_WINNER':
      return resolveMatchWinner(market, match);
    case 'TOSS_WINNER':
      if (match.toss) return win([match.toss.winnerKey]);
      return finished(match) ? voidResult('toss did not take place') : null;
    case 'INNINGS_TOTAL':
      return resolveInningsTotal(market, match);
    case 'SESSION_RUNS':
      return resolveSession(market, match, balls);
    case 'NEXT_OVER_RUNS':
      return resolveNextOver(market, match, balls);
    case 'FALL_OF_NEXT_WICKET':
      return resolveFallOfWicket(market, match);
    case 'DISMISSAL_METHOD':
      return resolveDismissal(market, match, balls);
    case 'PLAYER_RUNS':
      return resolvePlayerRuns(market, match);
    case 'TOP_BATSMAN':
    case 'TOP_BOWLER':
      return resolveTopPlayer(market, match);
    case 'OPENING_PARTNERSHIP':
      return resolveOpening(market, match);
    case 'CUSTOM':
      return null; // always settled by an admin
  }
}
