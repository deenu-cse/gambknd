import type { BallEvent } from '../types.js';
import type { Rng } from './rng.js';

const LINES: Record<string, readonly string[]> = {
  dot: ['defended solidly back to the bowler', 'beaten outside off', 'pushed to cover, no run', 'left alone outside off', 'tucked to midwicket, straight to the fielder'],
  one: ['nudged to fine leg for a single', 'worked off the pads for one', 'dropped into the off side, quick single', 'driven to long-off for one'],
  two: ['clipped into the gap, they come back for two', 'pushed wide of mid-off for a couple', 'swept fine, two runs'],
  three: ['driven into the deep, excellent running gets three'],
  four: ['FOUR! Cracking drive through the covers', 'FOUR! Pulled hard behind square', 'FOUR! Edged, and it races past slip', 'FOUR! Cut late past point'],
  six: ['SIX! Launched over long-on', 'SIX! Swung into the stands over midwicket', 'SIX! Lofted straight back over the bowler'],
};

const WICKET: Record<string, string> = {
  CAUGHT: 'OUT! Caught',
  BOWLED: 'OUT! Bowled him',
  LBW: 'OUT! Trapped in front, lbw',
  RUN_OUT: 'OUT! Run out',
  STUMPED: 'OUT! Stumped',
  HIT_WICKET: 'OUT! Hit wicket',
  OTHER: 'OUT!',
};

/** Generated sentence for a replay delivery: "{bowler} to {batter}, {what happened}". */
export function commentaryFor(rng: Rng, b: BallEvent): string {
  const lead = `${b.bowlerName} to ${b.batterName}`;
  if (b.wicket) {
    const by = b.wicket.fielderName && b.wicket.kind !== 'BOWLED' && b.wicket.kind !== 'LBW' ? ` by ${b.wicket.fielderName}` : '';
    return `${lead}, ${WICKET[b.wicket.kind] ?? 'OUT!'}${by}. ${b.wicket.playerOutName} has to go.`;
  }
  if (b.extras.wides > 0) return `${lead}, wide down the leg side.`;
  if (b.extras.noBalls > 0) return `${lead}, no-ball! Free hit coming up.`;
  if (b.extras.legByes > 0) return `${lead}, off the pads, ${b.extras.legByes} leg bye.`;
  if (b.extras.byes > 0) return `${lead}, misses everything, ${b.extras.byes} bye.`;
  const key = b.runsBat === 0 ? 'dot' : b.runsBat === 1 ? 'one' : b.runsBat === 2 ? 'two' : b.runsBat === 3 ? 'three' : b.runsBat === 4 ? 'four' : 'six';
  return `${lead}, ${rng.pick(LINES[key] ?? LINES.dot ?? ['no run'])}.`;
}
