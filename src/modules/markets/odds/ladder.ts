/**
 * Standard exchange-style odds ladder, as integers (decimal odds ×100).
 * 1.01–2 by 0.01, 2–3 by 0.02, 3–4 by 0.05, 4–6 by 0.1, 6–10 by 0.2, 10–20 by 0.5,
 * 20–30 by 1, 30–50 by 2, 50–100 by 5.
 */
export const MIN_ODDS = 101;
export const MAX_ODDS = 10_000;

const BANDS: ReadonlyArray<readonly [from: number, to: number, step: number]> = [
  [101, 200, 1],
  [202, 300, 2],
  [305, 400, 5],
  [410, 600, 10],
  [620, 1000, 20],
  [1050, 2000, 50],
  [2100, 3000, 100],
  [3200, 5000, 200],
  [5500, 10_000, 500],
];

export const LADDER: readonly number[] = BANDS.flatMap(([from, to, step]) => {
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
});

/** Snap to the ladder. Default rounds DOWN, i.e. never offers more than the computed price. */
export function toLadder(odds: number, mode: 'down' | 'up' | 'nearest' = 'down'): number {
  if (!Number.isFinite(odds) || odds <= MIN_ODDS) return MIN_ODDS;
  if (odds >= MAX_ODDS) return MAX_ODDS;
  let lo = 0;
  let hi = LADDER.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((LADDER[mid] as number) <= odds) lo = mid;
    else hi = mid - 1;
  }
  const below = LADDER[lo] as number;
  if (below === odds) return below;
  const above = LADDER[lo + 1] ?? below;
  if (mode === 'down') return below;
  if (mode === 'up') return above;
  return odds - below <= above - odds ? below : above;
}

export function isOnLadder(odds: number): boolean {
  return toLadder(odds) === odds;
}

/** Ticks between two ladder prices (for "odds moved" UI and sanity checks). */
export function ticksBetween(a: number, b: number): number {
  return Math.abs(LADDER.indexOf(toLadder(a)) - LADDER.indexOf(toLadder(b)));
}

export function formatDecimal(odds: number): string {
  return (odds / 100).toFixed(2);
}
