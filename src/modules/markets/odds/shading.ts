import { normalizeBps } from './margin.js';

export interface ShadingConfig {
  /** Start shading once worst-case loss on a selection exceeds this share of maxLiability (bps). */
  startBps: number;
  /** Maximum boost to a selection's probability, in bps of its own probability (1500 = ×1.15). */
  maxBoostBps: number;
}

export const DEFAULT_SHADING: ShadingConfig = { startBps: 5_000, maxBoostBps: 1_500 };

/**
 * Liability-based shading, the way bookmakers balance books: when the house would lose a lot
 * if selection S wins, shorten S (raise its probability) and let the renormalisation lengthen
 * the others. `worstCaseLoss[s]` = payouts owed if s wins − total stakes on the market (minor units).
 */
export function applyLiabilityShading(
  fairBps: Record<string, number>,
  worstCaseLoss: Record<string, number>,
  maxLiability: number,
  cfg: ShadingConfig = DEFAULT_SHADING,
): Record<string, number> {
  if (maxLiability <= 0) return fairBps;
  const threshold = (maxLiability * cfg.startBps) / 10_000;
  const boosted: Record<string, number> = {};
  let changed = false;
  for (const [id, p] of Object.entries(fairBps)) {
    const loss = worstCaseLoss[id] ?? 0;
    if (loss <= threshold) {
      boosted[id] = p;
      continue;
    }
    // Linear from 0 at the threshold to max boost at full liability.
    const severity = Math.min(1, (loss - threshold) / (maxLiability - threshold || 1));
    boosted[id] = p * (1 + (severity * cfg.maxBoostBps) / 10_000);
    changed = true;
  }
  return changed ? normalizeBps(boosted) : fairBps;
}
