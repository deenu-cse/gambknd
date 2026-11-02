import type { Innings, MatchFormat, TeamRef } from '../types.js';
import { normalizeTeamKey, oversToBalls } from './text.js';

export interface RawScoreLine {
  r: number;
  w: number;
  o: number;
  inning: string;
}

interface ParsedLabel {
  candidates: string[]; // team keys named in the label
  sideInnings: number; // the "Inning N" number (that side's own innings count)
}

function parseLabel(label: string): ParsedLabel {
  const m = /^(.*?)\s*Inning\s*(\d+)\s*$/i.exec(label.trim());
  const namesPart = m?.[1] ?? label;
  const sideInnings = m?.[2] ? Number(m[2]) : 1;
  const candidates = namesPart.split(',').map((n) => normalizeTeamKey(n)).filter(Boolean);
  return { candidates, sideInnings };
}

function emptyInnings(number: number, battingTeamKey: string, bowlingTeamKey: string, inferred: boolean): Innings {
  return {
    number,
    battingTeamKey,
    bowlingTeamKey,
    battingTeamInferred: inferred,
    runs: 0,
    wickets: 0,
    balls: 0,
    isComplete: false,
    target: null,
    allottedBalls: null,
    extras: null,
    batting: [],
    bowling: [],
    fallOfWickets: [],
  };
}

/**
 * Turns `score[]` into innings with a resolved batting team. Handles the provider's label quirks
 * (DATA_MAPPING §3.2): lowercase names, and "A,B Inning 1" labels where the batting side is
 * whichever named team hasn't already batted that innings number.
 */
export function resolveInnings(
  scores: readonly RawScoreLine[],
  teams: readonly [TeamRef, TeamRef],
  format: MatchFormat,
  scheduledOvers: number | null,
  matchEnded: boolean,
): Innings[] {
  const keys = teams.map((t) => t.key);
  const out: Innings[] = [];
  const battedCount = new Map<string, number>();

  scores.forEach((line, idx) => {
    const label = parseLabel(line.inning);
    let candidates = label.candidates.filter((c) => keys.includes(c));
    if (candidates.length === 0) {
      // Label didn't match by exact key (e.g. abbreviations): fall back to prefix matching.
      candidates = keys.filter((k) => label.candidates.some((c) => c && (k.startsWith(c) || c.startsWith(k))));
    }
    let batting: string | undefined;
    let inferred = false;
    if (candidates.length === 1) {
      batting = candidates[0];
    } else {
      const pool = candidates.length > 1 ? candidates : keys;
      const notYet = pool.filter((k) => (battedCount.get(k) ?? 0) < label.sideInnings);
      if (notYet.length === 1) {
        batting = notYet[0];
      } else {
        // Still ambiguous (e.g. Test follow-on): alternate from the previous innings.
        const prev = out[idx - 1]?.battingTeamKey;
        batting = keys.find((k) => k !== prev) ?? keys[0];
        inferred = true;
      }
    }
    const battingKey = batting ?? keys[0] ?? 'unknown';
    const bowlingKey = keys.find((k) => k !== battingKey) ?? keys[1] ?? 'unknown';
    battedCount.set(battingKey, (battedCount.get(battingKey) ?? 0) + 1);

    const inn = emptyInnings(idx + 1, battingKey, bowlingKey, inferred);
    inn.runs = Math.max(0, Math.trunc(line.r));
    inn.wickets = Math.min(10, Math.max(0, Math.trunc(line.w)));
    inn.balls = oversToBalls(line.o);
    inn.allottedBalls = format === 'TEST' || scheduledOvers === null ? null : scheduledOvers * 6;
    out.push(inn);
  });

  return finalizeInnings(out, format, matchEnded);
}

/** Completion flags and chase targets, shared with the replay provider. */
export function finalizeInnings(innings: Innings[], format: MatchFormat, matchEnded: boolean): Innings[] {
  innings.forEach((inn, idx) => {
    const later = idx < innings.length - 1;
    const allOut = inn.wickets >= 10;
    const oversDone = inn.allottedBalls !== null && inn.balls >= inn.allottedBalls;
    inn.isComplete = later || allOut || oversDone || matchEnded;
  });

  if (format !== 'TEST' && innings.length >= 2) {
    const first = innings[0];
    const second = innings[1];
    if (first && second) {
      second.target = first.runs + 1;
      if (second.runs >= second.target) second.isComplete = true;
    }
  }
  if (format === 'TEST' && innings.length === 4) {
    const fourth = innings[3];
    if (fourth) {
      const total = (team: string) => innings.slice(0, 3).filter((i) => i.battingTeamKey === team).reduce((s, i) => s + i.runs, 0);
      fourth.target = total(fourth.bowlingTeamKey) - total(fourth.battingTeamKey) + 1;
      if (fourth.runs >= fourth.target) fourth.isComplete = true;
    }
  }
  return innings;
}

export { emptyInnings };
