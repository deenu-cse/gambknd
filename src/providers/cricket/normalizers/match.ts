import type { RawCricScore, RawMatch } from '../live/schemas.js';
import type { ProviderMatch, ScoreTick, TeamRef } from '../types.js';
import { resolveInnings } from './innings.js';
import { deriveMatchStatus, parseResultText, parseTossText, tossFromFields } from './status.js';
import {
  cleanImage,
  deriveShortName,
  extractMatchLabel,
  extractSeriesName,
  inferFormat,
  normalizeTeamKey,
  parseGmt,
  parseVenue,
  scheduledOversFor,
  splitBracketName,
} from './text.js';

export function buildTeamRef(name: string, shortName?: string | null, img?: string | null): TeamRef {
  const { name: clean, short } = splitBracketName(name);
  return {
    key: normalizeTeamKey(clean),
    name: clean,
    shortName: (shortName ?? short ?? '').trim() || deriveShortName(clean),
    logoUrl: cleanImage(img),
  };
}

/** teamInfo order is not teams[] order (and may have fewer entries): always join by key. */
function teamsOf(raw: RawMatch): [TeamRef, TeamRef] | null {
  if (raw.teams.length < 2) return null;
  const info = new Map(raw.teamInfo.map((t) => [normalizeTeamKey(t.name), t]));
  const refs = raw.teams.slice(0, 2).map((name) => {
    const i = info.get(normalizeTeamKey(name));
    return buildTeamRef(name, i?.shortname, i?.img);
  });
  return [refs[0] as TeamRef, refs[1] as TeamRef];
}

/** currentMatches / matches / series_info.matchList / match_info → ProviderMatch. null if unusable. */
export function normalizeMatch(raw: RawMatch, seriesNameHint?: string | null): ProviderMatch | null {
  const teams = teamsOf(raw);
  if (!teams) return null;
  const seriesName = seriesNameHint ?? extractSeriesName(raw.name);
  const format = inferFormat(raw.matchType, raw.name, seriesName);
  const scheduledOvers = scheduledOversFor(format, raw.status);
  const { date, confirmed } = parseGmt(raw.dateTimeGMT, raw.date);
  const innings = resolveInnings(raw.score, teams, format, scheduledOvers, raw.matchEnded);

  const last = innings.at(-1);
  const maxInnings = format === 'TEST' ? 4 : 2;
  const betweenInnings = !raw.matchEnded && !!last && last.isComplete && innings.length < maxInnings;
  const status = deriveMatchStatus({
    matchStarted: raw.matchStarted,
    matchEnded: raw.matchEnded,
    statusText: raw.status,
    hasScore: innings.length > 0,
    betweenInnings,
  });

  let result = status === 'COMPLETED' || status === 'ABANDONED' || status === 'NO_RESULT' ? parseResultText(raw.status, teams) : null;
  if (result && raw.matchWinner && !result.winnerKey && result.type === 'WIN') {
    const winner = buildTeamRef(raw.matchWinner).key;
    if (teams.some((t) => t.key === winner)) result = { ...result, winnerKey: winner, confident: true };
  }

  return {
    providerId: raw.id,
    source: 'live',
    title: raw.name,
    matchLabel: extractMatchLabel(raw.name),
    seriesProviderId: raw.series_id ?? null,
    seriesName,
    format,
    scheduledOvers,
    teams,
    venue: parseVenue(raw.venue),
    startTime: date,
    startTimeConfirmed: confirmed,
    status,
    statusText: raw.status,
    toss: tossFromFields(raw.tossWinner, raw.tossChoice, teams) ?? parseTossText(raw.status, teams),
    innings,
    result,
    capabilities: { ballByBall: raw.bbbEnabled, scorecard: raw.matchStarted, toss: true, squads: raw.hasSquad, playerStats: true },
  };
}

/** cricScore row → change-detector tick. The fingerprint changes whenever anything visible changes. */
export function normalizeCricScore(raw: RawCricScore): ScoreTick {
  return {
    providerId: raw.id,
    phase: raw.ms,
    fingerprint: [raw.ms, raw.t1s, raw.t2s, raw.status].join('|'),
  };
}
