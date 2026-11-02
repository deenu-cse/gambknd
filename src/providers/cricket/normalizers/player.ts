import type { RawPlayerInfo, RawSquad, RawSquadPlayer } from '../live/schemas.js';
import type { BattingStats, BowlingStats, PlayerProfile, PlayerRole, Squad, SquadPlayer, StatFormat } from '../types.js';
import { buildTeamRef } from './match.js';
import { cleanImage, cleanText } from './text.js';

export function normalizeRole(role: string | undefined): PlayerRole {
  const r = (cleanText(role) ?? '').toLowerCase();
  if (r.includes('wk')) return 'WK_BATTER';
  if (r.includes('batting allrounder')) return 'BAT_ALLROUNDER';
  if (r.includes('bowling allrounder')) return 'BOWL_ALLROUNDER';
  if (r.includes('allrounder')) return 'BAT_ALLROUNDER';
  if (r.includes('bowler')) return 'BOWLER';
  if (r.includes('bats')) return 'BATTER';
  return 'UNKNOWN';
}

export function normalizeBattingStyle(style: string | undefined): 'RHB' | 'LHB' | null {
  const s = (cleanText(style) ?? '').toLowerCase();
  if (s.startsWith('right')) return 'RHB';
  if (s.startsWith('left')) return 'LHB';
  return null;
}

export function bowlingTypeOf(style: string | undefined): 'PACE' | 'SPIN' | null {
  const s = (cleanText(style) ?? '').toLowerCase();
  if (!s) return null;
  if (/orthodox|offbreak|off-break|legbreak|leg-break|chinaman|googly|spin|wrist/.test(s)) return 'SPIN';
  if (/fast|medium|pace|seam/.test(s)) return 'PACE';
  return null;
}

export function normalizeSquadPlayer(raw: RawSquadPlayer): SquadPlayer {
  return {
    playerId: raw.id,
    name: raw.name.trim(),
    role: normalizeRole(raw.role),
    battingStyle: normalizeBattingStyle(raw.battingStyle),
    bowlingStyle: cleanText(raw.bowlingStyle),
    bowlingType: bowlingTypeOf(raw.bowlingStyle),
    country: cleanText(raw.country),
    imageUrl: cleanImage(raw.playerImg),
  };
}

export function normalizeSquad(raw: RawSquad): Squad {
  return { team: buildTeamRef(raw.teamName, raw.shortname, raw.img), players: raw.players.map(normalizeSquadPlayer) };
}

const FORMAT_MAP: Record<string, StatFormat> = { test: 'TEST', odi: 'ODI', t20: 'T20', t20i: 'T20' };

/** Decimal stat strings → ×100 integers ("27.45" → 2745). No floats leave this module. */
function x100(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function int(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/** "3/25" → { wickets: 3, runs: 25 }; "-/-" → null */
function figures(value: string): { wickets: number; runs: number } | null {
  const m = /^(\d+)\/(\d+)$/.exec(value);
  return m?.[1] && m[2] ? { wickets: Number(m[1]), runs: Number(m[2]) } : null;
}

function emptyBatting(): BattingStats {
  return { matches: 0, innings: 0, runs: 0, ballsFaced: 0, highScore: 0, highScoreNotOut: false, average100: 0, strikeRate100: 0, notOuts: 0, fours: 0, sixes: 0, fifties: 0, hundreds: 0, doubleHundreds: 0 };
}

function emptyBowling(): BowlingStats {
  return { matches: 0, innings: 0, balls: 0, runs: 0, wickets: 0, average100: 0, economy100: 0, strikeRate100: 0, bestInnings: null, bestMatch: null, fiveWickets: 0, tenWickets: 0 };
}

function applyBatting(s: BattingStats, stat: string, v: string): void {
  switch (stat) {
    case 'm': s.matches = int(v); break;
    case 'inn': s.innings = int(v); break;
    case 'runs': s.runs = int(v); break;
    case 'bf': s.ballsFaced = int(v); break;
    case 'hs': s.highScore = int(v); s.highScoreNotOut = v.endsWith('*'); break;
    case 'avg': s.average100 = x100(v); break;
    case 'sr': s.strikeRate100 = x100(v); break;
    case 'no': s.notOuts = int(v); break;
    case '4s': s.fours = int(v); break;
    case '6s': s.sixes = int(v); break;
    case '50': s.fifties = int(v); break;
    case '100': s.hundreds = int(v); break;
    case '200': s.doubleHundreds = int(v); break;
    default: break;
  }
}

function applyBowling(s: BowlingStats, stat: string, v: string): void {
  switch (stat) {
    case 'm': s.matches = int(v); break;
    case 'inn': s.innings = int(v); break;
    case 'b': s.balls = int(v); break;
    case 'runs': s.runs = int(v); break;
    case 'wkts': s.wickets = int(v); break;
    case 'avg': s.average100 = x100(v); break;
    case 'econ': s.economy100 = x100(v); break;
    case 'sr': s.strikeRate100 = x100(v); break;
    case 'bbi': s.bestInnings = figures(v); break;
    case 'bbm': s.bestMatch = figures(v); break;
    case '5w': s.fiveWickets = int(v); break;
    case '10w': s.tenWickets = int(v); break;
    default: break;
  }
}

/** The provider sends stats as padded EAV rows; pivot to { batting: { T20: {...} }, bowling: {...} }. */
export function pivotStats(rows: RawPlayerInfo['stats']): PlayerProfile['stats'] {
  const batting: PlayerProfile['stats']['batting'] = {};
  const bowling: PlayerProfile['stats']['bowling'] = {};
  for (const row of rows) {
    const format = FORMAT_MAP[row.matchtype.trim().toLowerCase()];
    if (!format) continue;
    const stat = row.stat.trim().toLowerCase();
    const value = String(row.value).trim();
    if (row.fn.trim().toLowerCase() === 'batting') applyBatting((batting[format] ??= emptyBatting()), stat, value);
    else if (row.fn.trim().toLowerCase() === 'bowling') applyBowling((bowling[format] ??= emptyBowling()), stat, value);
  }
  return { batting, bowling };
}

export function normalizePlayerInfo(raw: RawPlayerInfo): PlayerProfile {
  const dob = cleanText(raw.dateOfBirth);
  const parsedDob = dob ? new Date(dob) : null;
  return {
    ...normalizeSquadPlayer(raw),
    placeOfBirth: cleanText(raw.placeOfBirth),
    dateOfBirth: parsedDob && !Number.isNaN(parsedDob.getTime()) ? parsedDob : null,
    stats: pivotStats(raw.stats),
  };
}
