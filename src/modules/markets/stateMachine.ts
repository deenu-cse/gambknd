import type { MarketStatus } from './types.js';

/**
 * PENDING → OPEN ⇄ SUSPENDED → CLOSED → SETTLED, and → VOID from any unsettled state.
 * Resettlement (Phase 6) re-enters SETTLED from SETTLED through its own audited path.
 */
const TRANSITIONS: Record<MarketStatus, readonly MarketStatus[]> = {
  PENDING: ['OPEN', 'SUSPENDED', 'CLOSED', 'VOID'],
  OPEN: ['SUSPENDED', 'CLOSED', 'VOID'],
  SUSPENDED: ['OPEN', 'CLOSED', 'VOID'],
  CLOSED: ['SETTLED', 'VOID'],
  SETTLED: [],
  VOID: [],
};

export function canTransition(from: MarketStatus, to: MarketStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: MarketStatus, to: MarketStatus): void {
  if (!canTransition(from, to)) throw new Error(`illegal market transition ${from} → ${to}`);
}

/** Markets the engine still manages (prices, suspends, closes). */
export const ACTIVE_STATUSES: readonly MarketStatus[] = ['PENDING', 'OPEN', 'SUSPENDED'];
