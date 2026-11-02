import { normalizeBps, priceSelections } from './odds/margin.js';
import { applyLiabilityShading } from './odds/shading.js';
import type { MarketBook } from './liability.js';
import type { IMarket, ISelection } from './market.model.js';
import type { PricingContext } from './pricing/context.js';
import { definitionFor } from './pricing/registry.js';
import { BALL_REASONS, type MarketStatus, type SuspendReason } from './types.js';

export interface EvalSettings {
  oneSidedThresholdBps: number;
  shadingStartBps: number;
  shadingMaxBoostBps: number;
}

export interface EvalInput {
  /** A delivery just happened (and what kind), or null. */
  ball: { reason: 'BALL' | 'WICKET' | 'BOUNDARY'; token: string } | null;
  /** The reopen job may lift ball suspensions carrying this token. */
  reopenToken: string | null;
  book: MarketBook | null;
  settings: EvalSettings;
}

export interface MarketPatch {
  status: MarketStatus;
  suspendReason: SuspendReason | null;
  suspendToken: string | null;
  selections: ISelection[];
  closedAt: Date | null;
  lastPricedAt: Date | null;
  kind: 'status' | 'odds' | null;
}

const REVIEW = /\b(review|drs|third umpire|tv umpire)\b/i;

/**
 * Decides one market's next state from the match context. Pure: no I/O. Order matters:
 * close beats everything; an admin suspension is sticky; then match-level conditions;
 * then pricing problems; then the per-ball safety suspension; otherwise open.
 */
export function evaluateMarket(m: IMarket, ctx: PricingContext, input: EvalInput): MarketPatch | null {
  if (m.status === 'CLOSED' || m.status === 'SETTLED' || m.status === 'VOID') return null;
  const def = m.type === 'CUSTOM' ? null : definitionFor(m.type);
  const like = { key: m.key, type: m.type as Exclude<IMarket['type'], 'CUSTOM'>, params: m.params, selections: m.selections, lineX10: m.lineX10, status: m.status, inPlay: m.inPlay };
  const now = new Date();

  if (ctx.finished || (def && def.shouldClose(like, ctx))) {
    return { status: 'CLOSED', suspendReason: null, suspendToken: null, selections: m.selections, closedAt: now, lastPricedAt: m.lastPricedAt, kind: 'status' };
  }

  // ── Price ──
  let selections = m.selections;
  let fair: Record<string, number> | null = null;
  if (m.autoManaged && def) {
    const raw = def.price(like, ctx);
    const active = m.selections.filter((s) => s.status === 'ACTIVE');
    if (raw && active.length >= 2) {
      fair = normalizeBps(Object.fromEntries(active.map((s) => [s.id, raw[s.id] ?? 0])));
      const shaded = input.book
        ? applyLiabilityShading(fair, input.book.worstCaseLoss, m.maxLiability, { startBps: input.settings.shadingStartBps, maxBoostBps: input.settings.shadingMaxBoostBps })
        : fair;
      const odds = priceSelections(shaded, m.marginBps);
      selections = m.selections.map((s) => (s.status === 'ACTIVE' ? { ...s, odds: odds[s.id] ?? s.odds, probabilityBps: fair?.[s.id] ?? 0 } : s));
    }
  }

  // ── Status ──
  let status: MarketStatus = 'OPEN';
  let reason: SuspendReason | null = null;
  let token: string | null = null;
  const ballSuspended = m.status === 'SUSPENDED' && m.suspendReason !== null && BALL_REASONS.includes(m.suspendReason);
  const { match } = ctx;

  if (m.status === 'SUSPENDED' && m.suspendReason === 'ADMIN') reason = 'ADMIN';
  else if (!match.bettingEnabled) reason = 'BETTING_DISABLED';
  else if (m.inPlay && match.stale) reason = 'STALE';
  else if (m.inPlay && match.status === 'RAIN_DELAY') reason = 'RAIN';
  else if (m.inPlay && REVIEW.test(match.statusText)) reason = 'REVIEW';
  else if (m.autoManaged && def && !fair) reason = 'NO_PRICE';
  else if (fair && Math.max(...Object.values(fair)) >= input.settings.oneSidedThresholdBps) reason = 'ONE_SIDED';
  else if (input.ball && m.inPlay) {
    reason = input.ball.reason;
    token = input.ball.token;
  } else if (ballSuspended && m.suspendToken !== input.reopenToken) {
    // Still inside the bet-safety window of an earlier delivery: only the reopen job lifts it.
    reason = m.suspendReason;
    token = m.suspendToken;
  }
  if (reason) status = 'SUSPENDED';

  const statusChanged = status !== m.status || reason !== m.suspendReason || token !== m.suspendToken;
  const oddsChanged = selections.some((s, i) => s.odds !== m.selections[i]?.odds);
  const probChanged = selections.some((s, i) => s.probabilityBps !== m.selections[i]?.probabilityBps);
  if (!statusChanged && !oddsChanged && !probChanged) return null;
  return {
    status,
    suspendReason: reason,
    suspendToken: token,
    selections,
    closedAt: null,
    lastPricedAt: fair ? now : m.lastPricedAt,
    kind: statusChanged ? 'status' : oddsChanged ? 'odds' : null,
  };
}
