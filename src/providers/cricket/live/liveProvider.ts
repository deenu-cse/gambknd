import { z } from 'zod';
import { logger } from '../../../config/logger.js';
import { ProviderError, type CricketProvider } from '../adapter.js';
import { normalizeCricScore, normalizeMatch } from '../normalizers/match.js';
import { normalizePlayerInfo, normalizeSquad } from '../normalizers/player.js';
import { mergeScorecard, normalizeBalls } from '../normalizers/scorecard.js';
import { normalizeCountry, normalizeSeries } from '../normalizers/series.js';
import type { BallEvent, Country, Innings, MatchResult, PlayerProfile, ProviderCapabilities, ProviderMatch, ScoreTick, SeriesInfo, Squad } from '../types.js';
import type { CricApiClient } from './cricapi.client.js';
import {
  rawBbbSchema,
  rawCountrySchema,
  rawCricScoreSchema,
  rawMatchSchema,
  rawPlayerInfoSchema,
  rawScorecardSchema,
  rawSeriesSchema,
  rawSquadSchema,
} from './schemas.js';

/** Parses list items one by one: one malformed row is dropped, not the whole page. */
function each<S extends z.ZodTypeAny>(schema: S, rows: unknown, label: string): Array<z.infer<S>> {
  if (!Array.isArray(rows)) return [];
  const out: Array<z.infer<S>> = [];
  for (const row of rows) {
    const r = schema.safeParse(row);
    if (r.success) out.push(r.data as z.infer<S>);
    else logger.warn({ label, issue: r.error.issues[0]?.message }, 'dropped malformed provider row');
  }
  return out;
}

const list = z.array(z.unknown());

export interface LiveProviderOptions {
  ballByBall: boolean;
  scorecard: boolean;
}

/** CricAPI v1 → internal models. See docs/API_CONTRACT.md for every endpoint used here. */
export class LiveProvider implements CricketProvider {
  readonly source = 'live' as const;

  constructor(
    private readonly client: CricApiClient,
    private readonly opts: LiveProviderOptions,
  ) {}

  capabilities(): ProviderCapabilities {
    return { ballByBall: this.opts.ballByBall, scorecard: this.opts.scorecard, toss: true, squads: true, playerStats: true };
  }

  async getMatches(): Promise<ProviderMatch[]> {
    const [current, fixtures] = await Promise.all([
      this.client.get('currentMatches', { offset: 0 }, list),
      this.client.get('matches', { offset: 0 }, list),
    ]);
    const byId = new Map<string, ProviderMatch>();
    // currentMatches carries scores, so it wins over the fixture list for the same id.
    for (const raw of [...each(rawMatchSchema, fixtures.data, 'matches'), ...each(rawMatchSchema, current.data, 'currentMatches')]) {
      const m = normalizeMatch(raw);
      if (m) byId.set(m.providerId, m);
    }
    return [...byId.values()];
  }

  async getMatchDetail(providerId: string): Promise<ProviderMatch> {
    const res = await this.client.get('match_info', { id: providerId }, rawMatchSchema, 'critical');
    const m = normalizeMatch(res.data);
    if (!m) throw new ProviderError('BAD_RESPONSE', 'match_info: match has no teams');
    return m;
  }

  async getLiveScore(): Promise<ScoreTick[]> {
    const res = await this.client.get('cricScore', {}, list);
    return each(rawCricScoreSchema, res.data, 'cricScore').map(normalizeCricScore);
  }

  async getBallByBall(providerId: string): Promise<BallEvent[]> {
    if (!this.opts.ballByBall) throw new ProviderError('UNSUPPORTED', 'ball-by-ball is disabled for this plan');
    const res = await this.client.get('match_bbb', { id: providerId }, rawBbbSchema);
    return normalizeBalls(res.data.bbb);
  }

  async getScorecard(providerId: string): Promise<Innings[]> {
    if (!this.opts.scorecard) throw new ProviderError('UNSUPPORTED', 'scorecard is disabled for this plan');
    const res = await this.client.get('match_scorecard', { id: providerId }, rawScorecardSchema);
    const match = normalizeMatch(res.data);
    return match ? mergeScorecard(match.innings, res.data.scorecard) : [];
  }

  async getSquads(ref: { providerId: string; seriesProviderId: string | null }): Promise<Squad[]> {
    try {
      const res = await this.client.get('match_squad', { id: ref.providerId }, list);
      const squads = each(rawSquadSchema, res.data, 'match_squad').map(normalizeSquad);
      if (squads.length > 0) return squads;
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind === 'BUDGET_EXHAUSTED') throw err;
    }
    if (!ref.seriesProviderId) return [];
    const res = await this.client.get('series_squad', { id: ref.seriesProviderId }, list);
    return each(rawSquadSchema, res.data, 'series_squad').map(normalizeSquad);
  }

  async getPlayerStats(playerId: string): Promise<PlayerProfile> {
    const res = await this.client.get('players_info', { id: playerId }, rawPlayerInfoSchema);
    return normalizePlayerInfo(res.data);
  }

  async getResult(providerId: string): Promise<MatchResult | null> {
    return (await this.getMatchDetail(providerId)).result;
  }

  async getSeries(): Promise<SeriesInfo[]> {
    const res = await this.client.get('series', { offset: 0 }, list);
    return each(rawSeriesSchema, res.data, 'series').map(normalizeSeries);
  }

  async getCountries(): Promise<Country[]> {
    const out: Country[] = [];
    for (let offset = 0; offset < 300; offset += 25) {
      const res = await this.client.get('countries', { offset }, list);
      const page = each(rawCountrySchema, res.data, 'countries').map(normalizeCountry);
      out.push(...page);
      if (page.length < 25 || (res.info?.totalRows !== undefined && out.length >= res.info.totalRows)) break;
    }
    return out;
  }
}
