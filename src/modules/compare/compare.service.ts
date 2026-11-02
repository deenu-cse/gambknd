import type { StatFormat } from '../../providers/cricket/types.js';
import { AppError } from '../../utils/errors.js';
import { Team } from '../matches/catalog.models.js';
import { Match, type IMatch } from '../matches/match.model.js';
import { getPlayer, type PlayerView } from '../matches/players.service.js';

type Done = Pick<IMatch, '_id' | 'title' | 'teams' | 'result' | 'innings' | 'venue' | 'startTime' | 'format'>;

function outcomeFor(m: Done, team: string): 'W' | 'L' | 'T' | 'NR' {
  const r = m.result;
  if (!r || r.type === 'NO_RESULT' || r.type === 'ABANDONED') return 'NR';
  if (r.type === 'TIE' || r.type === 'DRAW') return 'T';
  return r.winnerKey === team ? 'W' : 'L';
}

function summary(m: Done, team: string) {
  return {
    matchId: m._id.toString(),
    title: m.title,
    date: m.startTime,
    opponent: m.teams.find((t) => t.key !== team)?.name ?? '',
    outcome: outcomeFor(m, team),
    venue: m.venue?.name ?? null,
  };
}

function battingAverages(matches: Done[], team: string): { inningsPlayed: number; averageScore: number | null; highest: number | null } {
  const scores = matches.flatMap((m) => m.innings.filter((i) => i.battingTeamKey === team).map((i) => i.runs));
  return {
    inningsPlayed: scores.length,
    averageScore: scores.length ? Math.round(scores.reduce((s, r) => s + r, 0) / scores.length) : null,
    highest: scores.length ? Math.max(...scores) : null,
  };
}

const COMPLETED = { status: { $in: ['COMPLETED', 'ABANDONED', 'NO_RESULT'] } };
const FIELDS = '_id title teams result innings venue startTime format';

/** Team vs team, from our own match history (normalized provider data). */
export async function compareTeams(a: string, b: string, venueName?: string) {
  if (a === b) throw AppError.badRequest('Pick two different teams');
  const teams = await Team.find({ key: { $in: [a, b] } }).lean();
  if (teams.length !== 2) throw AppError.notFound('Team');
  const [h2h, formA, formB] = await Promise.all([
    Match.find({ ...COMPLETED, 'teams.key': { $all: [a, b] } }).sort({ startTime: -1 }).limit(20).select(FIELDS).lean(),
    Match.find({ ...COMPLETED, 'teams.key': a }).sort({ startTime: -1 }).limit(10).select(FIELDS).lean(),
    Match.find({ ...COMPLETED, 'teams.key': b }).sort({ startTime: -1 }).limit(10).select(FIELDS).lean(),
  ]);
  const venue = async (team: string) => {
    if (!venueName) return null;
    const rows = await Match.find({ ...COMPLETED, 'teams.key': team, 'venue.name': venueName }).select(FIELDS).lean();
    return { played: rows.length, won: rows.filter((m) => outcomeFor(m, team) === 'W').length };
  };
  const side = async (key: string, form: Done[]) => ({
    key,
    name: teams.find((t) => t.key === key)?.name ?? key,
    logoUrl: teams.find((t) => t.key === key)?.logoUrl ?? null,
    recentForm: form.map((m) => outcomeFor(m, key)),
    recentMatches: form.slice(0, 5).map((m) => summary(m, key)),
    batting: battingAverages(form, key),
    venueRecord: await venue(key),
  });
  return {
    a: await side(a, formA),
    b: await side(b, formB),
    headToHead: {
      played: h2h.length,
      aWins: h2h.filter((m) => outcomeFor(m, a) === 'W').length,
      bWins: h2h.filter((m) => outcomeFor(m, b) === 'W').length,
      other: h2h.filter((m) => ['T', 'NR'].includes(outcomeFor(m, a))).length,
      matches: h2h.slice(0, 10).map((m) => summary(m, a)),
    },
    venue: venueName ?? null,
  };
}

/** Radar axes scaled 0–100 against a fixed T20 reference (so both players share one scale). */
function radar(p: PlayerView, format: StatFormat) {
  const bat = p.stats?.batting[format];
  const bowl = p.stats?.bowling[format];
  const scale = (v: number, max: number) => Math.max(0, Math.min(100, Math.round((v / max) * 100)));
  const boundaries = bat && bat.ballsFaced > 0 ? ((bat.fours + bat.sixes) * 100) / bat.ballsFaced : 0;
  return {
    battingAverage: scale((bat?.average100 ?? 0) / 100, 50),
    strikeRate: scale((bat?.strikeRate100 ?? 0) / 100, 180),
    boundaryRate: scale(boundaries, 25),
    // Lower economy is better: 4 an over → 100, 12 an over → 0.
    economy: bowl && bowl.balls > 0 ? scale(12 - bowl.economy100 / 100, 8) : 0,
    wicketsPerMatch: bowl && bowl.matches > 0 ? scale(bowl.wickets / bowl.matches, 2.5) : 0,
    bowlingStrikeRate: bowl && bowl.wickets > 0 ? scale(40 - bowl.strikeRate100 / 100, 30) : 0,
  };
}

export async function comparePlayers(a: string, b: string, format: StatFormat) {
  if (a === b) throw AppError.badRequest('Pick two different players');
  const [pa, pb] = await Promise.all([getPlayer(a), getPlayer(b)]);
  return {
    format,
    a: { player: pa, batting: pa.stats?.batting[format] ?? null, bowling: pa.stats?.bowling[format] ?? null, radar: radar(pa, format) },
    b: { player: pb, batting: pb.stats?.batting[format] ?? null, bowling: pb.stats?.bowling[format] ?? null, radar: radar(pb, format) },
  };
}
