import type {
  BallEvent,
  Country,
  DataSource,
  Innings,
  MatchResult,
  PlayerProfile,
  ProviderCapabilities,
  ProviderMatch,
  ScoreTick,
  SeriesInfo,
  Squad,
} from './types.js';

/**
 * The only contract the rest of the backend knows. Implementations: LiveProvider (CricAPI)
 * and ReplayProvider (recorded/synthesized matches). Both return normalized internal models.
 */
export interface CricketProvider {
  readonly source: DataSource;
  capabilities(): ProviderCapabilities;
  /** Current, upcoming and just-finished matches. */
  getMatches(): Promise<ProviderMatch[]>;
  getMatchDetail(providerId: string): Promise<ProviderMatch>;
  /** Cheap change detector across all current matches. */
  getLiveScore(): Promise<ScoreTick[]>;
  getBallByBall(providerId: string): Promise<BallEvent[]>;
  getScorecard(providerId: string): Promise<Innings[]>;
  getSquads(ref: { providerId: string; seriesProviderId: string | null }): Promise<Squad[]>;
  getPlayerStats(playerId: string): Promise<PlayerProfile>;
  getResult(providerId: string): Promise<MatchResult | null>;
  getSeries(): Promise<SeriesInfo[]>;
  getCountries(): Promise<Country[]>;
}

export type ProviderErrorKind = 'UNAVAILABLE' | 'BUDGET_EXHAUSTED' | 'NOT_FOUND' | 'BAD_RESPONSE' | 'CIRCUIT_OPEN' | 'UNSUPPORTED';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
