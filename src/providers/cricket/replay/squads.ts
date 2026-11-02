import type { PlayerRole, SquadPlayer, TeamRef } from '../types.js';

/**
 * Teams without a captured squad get clearly-labelled placeholder players (A-18).
 * Ids are deterministic so the same replay always has the same players.
 */
export function placeholderSquad(team: TeamRef, size = 13): SquadPlayer[] {
  const roles: PlayerRole[] = ['BATTER', 'BATTER', 'WK_BATTER', 'BATTER', 'BAT_ALLROUNDER', 'BAT_ALLROUNDER', 'BOWL_ALLROUNDER', 'BOWLER', 'BOWLER', 'BOWLER', 'BOWLER', 'BATTER', 'BOWLER'];
  return Array.from({ length: size }, (_, i) => {
    const role = roles[i] ?? 'UNKNOWN';
    const bowls = role === 'BOWLER' || role === 'BOWL_ALLROUNDER' || role === 'BAT_ALLROUNDER';
    const spinner = i % 3 === 0;
    return {
      playerId: `rp-${team.key}-${i + 1}`,
      name: `${team.shortName} Player ${i + 1}`,
      role,
      battingStyle: i % 4 === 3 ? 'LHB' : 'RHB',
      bowlingStyle: bowls ? (spinner ? 'Right-arm offbreak' : 'Right-arm medium') : null,
      bowlingType: bowls ? (spinner ? 'SPIN' : 'PACE') : null,
      country: null,
      imageUrl: null,
    };
  });
}

const BATTING_ORDER: PlayerRole[] = ['BATTER', 'WK_BATTER', 'BAT_ALLROUNDER', 'UNKNOWN', 'BOWL_ALLROUNDER', 'BOWLER'];

/** Picks a plausible XI in batting order: specialists first, bowlers last. Pads short squads. */
export function pickEleven(team: TeamRef, squad: readonly SquadPlayer[]): SquadPlayer[] {
  const sorted = [...squad].sort((a, b) => BATTING_ORDER.indexOf(a.role) - BATTING_ORDER.indexOf(b.role));
  const xi = sorted.slice(0, 11);
  if (xi.length < 11) {
    const pad = placeholderSquad(team, 11).filter((p) => !xi.some((x) => x.playerId === p.playerId));
    xi.push(...pad.slice(0, 11 - xi.length));
  }
  // Keep at least one wicket-keeper in the XI if the squad has one.
  if (!xi.some((p) => p.role === 'WK_BATTER')) {
    const wk = sorted.find((p) => p.role === 'WK_BATTER');
    if (wk) xi[Math.min(4, xi.length - 1)] = wk;
  }
  return xi;
}

/** Five or six bowlers from the XI, specialists first. */
export function pickBowlers(xi: readonly SquadPlayer[]): SquadPlayer[] {
  const score = (p: SquadPlayer): number =>
    p.role === 'BOWLER' ? 0 : p.role === 'BOWL_ALLROUNDER' ? 1 : p.role === 'BAT_ALLROUNDER' ? 2 : p.bowlingStyle ? 3 : 4;
  const ranked = [...xi].filter((p) => p.role !== 'WK_BATTER').sort((a, b) => score(a) - score(b));
  return ranked.slice(0, ranked.filter((p) => score(p) <= 3).length >= 6 ? 6 : 5);
}
