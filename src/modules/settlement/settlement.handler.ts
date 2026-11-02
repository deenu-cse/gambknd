import type { MatchChange } from '../matches/matchEvents.js';
import { autoSettleMatch } from './settlement.service.js';

export type SettlementScheduler = (matchId: string) => Promise<void>;

/** Default: settle inline (tests, single-process dev). The worker swaps in a BullMQ-backed scheduler. */
let scheduleSettlement: SettlementScheduler = async (matchId) => {
  await autoSettleMatch(matchId);
};

export function setSettlementScheduler(fn: SettlementScheduler): void {
  scheduleSettlement = fn;
}

/** Registered after the market engine, so markets are already closed when this runs. */
export async function onMatchChangeSettle(change: MatchChange): Promise<void> {
  if (change.staleChanged !== null && !change.scoreChanged && change.newBalls.length === 0) return; // freshness only
  await scheduleSettlement(change.matchId);
}
