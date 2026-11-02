import { deriveCrease } from '../../providers/cricket/derive.js';
import type { BallEvent, Innings } from '../../providers/cricket/types.js';
import type { CreaseBatter, CreaseBowler, CurrentState } from './match.model.js';

function batterOf(inn: Innings, id: string | null, fallbackName: string | undefined): CreaseBatter | null {
  if (!id) return null;
  const line = inn.batting.find((b) => b.playerId === id);
  return line
    ? { id, name: line.name, runs: line.runs, balls: line.balls, fours: line.fours, sixes: line.sixes }
    : { id, name: fallbackName ?? id, runs: 0, balls: 0, fours: 0, sixes: 0 };
}

function bowlerOf(inn: Innings, id: string | null): CreaseBowler | null {
  if (!id) return null;
  const line = inn.bowling.find((b) => b.playerId === id);
  return line ? { id, name: line.name, balls: line.balls, runs: line.runs, wickets: line.wickets, maidens: line.maidens } : null;
}

/**
 * Scoreboard state for the latest innings. Crease details need ball-by-ball; without it
 * (score-only feeds) they stay null and the UI hides those widgets.
 */
export function computeCurrentState(innings: readonly Innings[], balls: readonly BallEvent[], previousWinProb: number | null): CurrentState | null {
  const inn = innings.at(-1);
  if (!inn) return null;
  const inningsBalls = balls.filter((b) => b.innings === inn.number);
  const crease = inningsBalls.length > 0 ? deriveCrease(inningsBalls) : null;
  const names = new Map<string, string>();
  for (const b of inningsBalls) {
    names.set(b.batterId, b.batterName);
    names.set(b.bowlerId, b.bowlerName);
  }

  const runsNeeded = inn.target !== null ? Math.max(0, inn.target - inn.runs) : null;
  const ballsRemaining = inn.allottedBalls !== null ? Math.max(0, inn.allottedBalls - inn.balls) : null;
  return {
    inningsNumber: inn.number,
    battingTeamKey: inn.battingTeamKey,
    bowlingTeamKey: inn.bowlingTeamKey,
    runs: inn.runs,
    wickets: inn.wickets,
    balls: inn.balls,
    runRate100: inn.balls > 0 ? Math.round((inn.runs * 600) / inn.balls) : 0,
    target: inn.target,
    runsNeeded,
    ballsRemaining,
    requiredRunRate100: runsNeeded !== null && ballsRemaining ? Math.round((runsNeeded * 600) / ballsRemaining) : null,
    striker: crease ? batterOf(inn, crease.strikerId, names.get(crease.strikerId ?? '')) : null,
    nonStriker: crease ? batterOf(inn, crease.nonStrikerId, names.get(crease.nonStrikerId ?? '')) : null,
    bowler: crease ? bowlerOf(inn, crease.bowlerId) : null,
    partnership: crease?.partnership ?? { runs: 0, balls: 0 },
    lastSixBalls: crease?.lastSixBalls ?? [],
    currentOverRuns: crease?.currentOverRuns ?? 0,
    winProbabilityBps: previousWinProb,
  };
}
