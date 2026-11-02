import { getRedis } from '../config/redis.js';
import { logger } from '../config/logger.js';
import type { MatchStatus } from '../providers/cricket/types.js';
import type { BallView, MatchLiveView } from '../modules/matches/match.views.js';
import type { MarketView } from '../modules/markets/market.views.js';
import type { AdminBetView, BetView } from '../modules/bets/bet.views.js';
import type { MarketBook } from '../modules/markets/liability.js';
import type { NotificationView } from '../modules/notifications/notifications.service.js';

/**
 * Cross-process domain events over Redis pub/sub. Workers (settlement, poller) and API
 * processes publish here; the Socket.IO layer subscribes and fans out to rooms.
 * Publish only AFTER the database transaction that caused the event has committed.
 */
export interface BusEvents {
  'wallet.changed': { userId: string; reason: string };
  'match.updated': { matchId: string; view: MatchLiveView };
  'match.ball': { matchId: string; ball: BallView };
  'match.status': { matchId: string; from: MatchStatus | null; to: MatchStatus };
  'match.stale': { matchId: string; stale: boolean };
  /** kind: what changed. 'odds' = prices only, so clients can flash just the changed buttons. */
  'market.updated': { matchId: string; kind: 'created' | 'status' | 'odds'; market: MarketView };
  'bet.updated': { userId: string; bet: BetView };
  /** Admin live feed (bets monitor) and risk view. */
  'admin.bet': { event: 'placed' | 'accepted' | 'rejected' | 'cashed_out' | 'voided' | 'settled'; bet: AdminBetView };
  'admin.liability': { matchId: string; marketId: string; book: MarketBook };
  'notification.new': { userId: string; notification: NotificationView };
  'leaderboard.updated': { period: 'daily' | 'weekly' | 'all' };
}

export type BusChannel = keyof BusEvents;

export const BUS_PREFIX = 'bus:';

export async function publish<C extends BusChannel>(channel: C, payload: BusEvents[C]): Promise<void> {
  try {
    await getRedis().publish(`${BUS_PREFIX}${channel}`, JSON.stringify(payload));
  } catch (err) {
    // Realtime is best effort: clients also refetch on reconnect, so a lost event isn't data loss.
    logger.warn({ err, channel }, 'bus publish failed');
  }
}
