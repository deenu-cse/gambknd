export const MARKET_TYPES = [
  'MATCH_WINNER',
  'TOSS_WINNER',
  'INNINGS_TOTAL',
  'SESSION_RUNS',
  'NEXT_OVER_RUNS',
  'FALL_OF_NEXT_WICKET',
  'TOP_BATSMAN',
  'TOP_BOWLER',
  'DISMISSAL_METHOD',
  'PLAYER_RUNS',
  'OPENING_PARTNERSHIP',
  'CUSTOM',
] as const;
export type MarketType = (typeof MARKET_TYPES)[number];
export type AutoMarketType = Exclude<MarketType, 'CUSTOM'>;

export const MARKET_STATUSES = ['PENDING', 'OPEN', 'SUSPENDED', 'CLOSED', 'SETTLED', 'VOID'] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

export const SUSPEND_REASONS = [
  'BALL', // every delivery, while odds are recalculated
  'WICKET',
  'BOUNDARY',
  'REVIEW', // DRS / third umpire
  'RAIN',
  'STALE', // provider data older than the stale threshold
  'ONE_SIDED', // a selection is near-certain; no fair price exists
  'NO_PRICE', // model cannot price right now
  'BETTING_DISABLED', // admin switched betting off for the match
  'ADMIN', // manual suspension; only an admin can reopen
] as const;
export type SuspendReason = (typeof SUSPEND_REASONS)[number];

/** Auto-cleared by the reopen job after the bet-safety delay. */
export const BALL_REASONS: readonly SuspendReason[] = ['BALL', 'WICKET', 'BOUNDARY'];
/** Auto-cleared by the engine as soon as the condition goes away. */
export const CONDITION_REASONS: readonly SuspendReason[] = ['REVIEW', 'RAIN', 'STALE', 'ONE_SIDED', 'NO_PRICE', 'BETTING_DISABLED'];

export const MARKET_GROUPS = ['MAIN', 'INNINGS', 'SESSIONS', 'OVER', 'WICKETS', 'PLAYERS', 'SPECIALS'] as const;
export type MarketGroup = (typeof MARKET_GROUPS)[number];

export const SELECTION_STATUSES = ['ACTIVE', 'REMOVED', 'WINNER', 'LOSER', 'VOID', 'DEAD_HEAT'] as const;
export type SelectionStatus = (typeof SELECTION_STATUSES)[number];

export interface MarketParams {
  innings?: number;
  overs?: number; // session end over (1-based count)
  over?: number; // 0-based over index (next-over markets)
  wicket?: number; // 1..10
  teamKey?: string;
  playerId?: string;
}

export interface SelectionSpec {
  id: string;
  name: string;
  teamKey?: string;
  playerId?: string;
}

/** A market that should exist. `key` is unique per match, so re-creating is a no-op. */
export interface MarketSpec {
  key: string;
  type: AutoMarketType;
  name: string;
  group: MarketGroup;
  params: MarketParams;
  inPlay: boolean;
  /** Over/under line ×10 (145.5 → 1455). Fixed at creation: bets and settlement use it. */
  lineX10: number | null;
  selections: SelectionSpec[];
  sortOrder: number;
}
