import { logger } from '../../config/logger.js';
import type { MatchStatus } from '../../providers/cricket/types.js';
import type { IBallEvent, IMatch } from './match.model.js';

/** What changed in one sync. Consumers: market engine (Phase 4), settlement (Phase 6). */
export interface MatchChange {
  matchId: string;
  match: IMatch;
  created: boolean;
  statusFrom: MatchStatus | null;
  statusTo: MatchStatus;
  newBalls: IBallEvent[];
  scoreChanged: boolean;
  tossChanged: boolean;
  resultChanged: boolean;
  /** Innings numbers that became complete in this sync. */
  inningsCompleted: number[];
  /** Set when only the data-freshness flag flipped. */
  staleChanged: boolean | null;
}

type Handler = (change: MatchChange) => Promise<void>;
const handlers: Array<{ name: string; fn: Handler }> = [];

/** Registered in-process by the worker. Handlers run in order; one failing doesn't block the next. */
export function registerMatchChangeHandler(name: string, fn: Handler): void {
  if (!handlers.some((h) => h.name === name)) handlers.push({ name, fn });
}

export function clearMatchChangeHandlers(): void {
  handlers.length = 0;
}

export async function dispatchMatchChange(change: MatchChange): Promise<void> {
  for (const h of handlers) {
    try {
      await h.fn(change);
    } catch (err) {
      logger.error({ err, handler: h.name, matchId: change.matchId }, 'match change handler failed');
    }
  }
}
