import type { MatchResult, MatchStatus, TeamRef, Toss } from '../types.js';
import { normalizeTeamKey } from './text.js';

export interface StatusInput {
  matchStarted: boolean;
  matchEnded: boolean;
  statusText: string;
  hasScore: boolean;
  /** cricScore phase, when known. */
  phase?: 'fixture' | 'live' | 'result';
  /** True when the last innings on the board is complete and no next innings has started. */
  betweenInnings?: boolean;
}

/** The provider has no status enum; rules from API_CONTRACT §3, first match wins. */
export function deriveMatchStatus(i: StatusInput): MatchStatus {
  const t = i.statusText;
  if (/abandon/i.test(t)) return 'ABANDONED';
  if (/no result/i.test(t)) return 'NO_RESULT';
  if (i.matchEnded || i.phase === 'result' || /\bwon by\b|\bwon the super over\b|match tied|\btied\b|\bdrawn\b|\bwon\b.*\binnings\b/i.test(t)) {
    return 'COMPLETED';
  }
  const started = i.matchStarted || i.phase === 'live' || i.hasScore;
  if (!started) {
    return /won the toss|opt(ed)? to|elected to|chose to/i.test(t) ? 'TOSS' : 'UPCOMING';
  }
  if (/rain|wet outfield|delayed|bad light|stumps|lunch|tea\b|drinks|interrupted/i.test(t)) return 'RAIN_DELAY';
  if (/innings break/i.test(t) || i.betweenInnings) return 'INNINGS_BREAK';
  if (!i.hasScore && /won the toss|opt(ed)? to|elected to|chose to/i.test(t)) return 'TOSS';
  return 'LIVE';
}

function matchTeam(fragment: string, teams: readonly TeamRef[]): TeamRef | null {
  const key = normalizeTeamKey(fragment);
  return (
    teams.find((t) => t.key === key) ??
    teams.find((t) => t.shortName.toLowerCase() === fragment.trim().toLowerCase()) ??
    teams.find((t) => key.length > 2 && (t.key.startsWith(key) || key.startsWith(t.key))) ??
    null
  );
}

/**
 * Parses the free-text result line. `confident` is false when we recognised the pattern
 * but couldn't map the winner to a team; such results go to manual settlement (A-12).
 */
export function parseResultText(text: string, teams: readonly TeamRef[]): MatchResult | null {
  const t = text.trim();
  const method = /\b(DLS|D\/L|VJD)\b/i.test(t) ? 'DLS' : null;
  if (/abandon/i.test(t)) return { type: 'ABANDONED', winnerKey: null, margin: null, method: null, superOver: false, confident: true };
  if (/no result/i.test(t)) return { type: 'NO_RESULT', winnerKey: null, margin: null, method: null, superOver: false, confident: true };
  if (/match drawn|\bdrawn\b/i.test(t)) return { type: 'DRAW', winnerKey: null, margin: null, method: null, superOver: false, confident: true };

  // [^()] keeps the winner fragment from swallowing "Match tied (" via the leftmost match.
  const superOver = /([^()]+?) won the super over/i.exec(t);
  if (/\btied\b/i.test(t)) {
    const fragment = superOver?.[1]?.trim();
    const winner = fragment ? matchTeam(fragment, teams) : null;
    if (winner) return { type: 'WIN', winnerKey: winner.key, margin: null, method, superOver: true, confident: true };
    return { type: 'TIE', winnerKey: null, margin: null, method, superOver: false, confident: !fragment };
  }

  const innings = /^(.+?) won by an innings and (\d+) runs?/i.exec(t);
  const byMargin = /^(.+?) won by (\d+) (runs?|wkts?|wickets?)\b/i.exec(t);
  const plain = /^(.+?) won\b/i.exec(t);
  const m = innings ?? byMargin ?? plain;
  if (!m?.[1]) return null;
  const winner = matchTeam(m[1], teams);
  let margin: MatchResult['margin'] = null;
  if (innings?.[2]) margin = { value: Number(innings[2]), unit: 'RUNS' };
  else if (byMargin?.[2] && byMargin[3]) margin = { value: Number(byMargin[2]), unit: /run/i.test(byMargin[3]) ? 'RUNS' : 'WICKETS' };
  return { type: 'WIN', winnerKey: winner?.key ?? null, margin, method, superOver: false, confident: winner !== null };
}

/** "Kuwait opt to bowl", "X won the toss and elected to bat" → Toss */
export function parseTossText(text: string, teams: readonly TeamRef[]): Toss | null {
  const m = /^(.+?)\s+(?:won the toss and\s+)?(?:opt(?:ed)?|elected|chose)\s+to\s+(bat|bowl|field)/i.exec(text.trim());
  if (!m?.[1] || !m[2]) return null;
  const team = matchTeam(m[1], teams);
  return team ? { winnerKey: team.key, decision: m[2].toLowerCase() === 'bat' ? 'BAT' : 'BOWL' } : null;
}

/** match_info gives tossWinner + tossChoice ("bat" | "bowl"). */
export function tossFromFields(winner: string | undefined, choice: string | undefined, teams: readonly TeamRef[]): Toss | null {
  if (!winner || !choice) return null;
  const team = matchTeam(winner, teams);
  if (!team) return null;
  return { winnerKey: team.key, decision: /bat/i.test(choice) ? 'BAT' : 'BOWL' };
}
