import type { BattingStats, BowlingStats, PlayerProfile, SquadPlayer } from '../types.js';
import { Rng } from './rng.js';

/**
 * Deterministic career numbers for replay players (source: 'replay'). They make the compare
 * page and pre-match player markets work offline. They are never mixed with live data (A-18).
 */
export function syntheticProfile(player: SquadPlayer): PlayerProfile {
  const rng = Rng.fromString(`stats:${player.playerId}`);
  const batter = player.role === 'BATTER' || player.role === 'WK_BATTER';
  const allrounder = player.role === 'BAT_ALLROUNDER' || player.role === 'BOWL_ALLROUNDER';
  const bowls = player.bowlingType !== null || player.role === 'BOWLER' || allrounder;

  const matches = rng.int(6, 60);
  const innings = Math.max(1, Math.round(matches * (batter ? 0.95 : allrounder ? 0.8 : 0.5)));
  const notOuts = rng.int(0, Math.max(1, Math.round(innings * 0.2)));
  const avg = batter ? rng.int(1600, 3600) : allrounder ? rng.int(1100, 2500) : rng.int(300, 1200);
  const runs = Math.round(((innings - notOuts || 1) * avg) / 100);
  const sr = batter ? rng.int(9500, 14500) : allrounder ? rng.int(9000, 13500) : rng.int(6000, 10500);
  const ballsFaced = Math.max(1, Math.round((runs * 10_000) / sr));
  const batting: BattingStats = {
    matches, innings, runs, ballsFaced,
    highScore: Math.min(runs, rng.int(Math.round(avg / 100), Math.round(avg / 30) + 10)),
    highScoreNotOut: rng.chance(0.25),
    average100: avg, strikeRate100: sr, notOuts,
    fours: Math.round(runs * 0.09), sixes: Math.round(runs * 0.03),
    fifties: batter ? rng.int(0, Math.round(innings / 8)) : rng.int(0, 1),
    hundreds: batter && rng.chance(0.15) ? 1 : 0,
    doubleHundreds: 0,
  };

  const profile: PlayerProfile = { ...player, placeOfBirth: null, dateOfBirth: null, stats: { batting: { T20: batting }, bowling: {} } };
  if (bowls) {
    const bInnings = Math.max(1, Math.round(matches * (player.role === 'BOWLER' ? 0.95 : 0.6)));
    const balls = bInnings * rng.int(12, 24);
    const economy = rng.int(550, 950);
    const bRuns = Math.round((balls * economy) / 600);
    const wickets = Math.max(1, Math.round(balls / rng.int(14, 26)));
    const bowling: BowlingStats = {
      matches, innings: bInnings, balls, runs: bRuns, wickets,
      average100: Math.round((bRuns * 100) / wickets),
      economy100: economy,
      strikeRate100: Math.round((balls * 100) / wickets),
      bestInnings: { wickets: Math.min(wickets, rng.int(2, 5)), runs: rng.int(8, 30) },
      bestMatch: null,
      fiveWickets: rng.chance(0.1) ? 1 : 0,
      tenWickets: 0,
    };
    profile.stats.bowling.T20 = bowling;
  }
  return profile;
}
