import countries from '../fixtures/countries.json' with { type: 'json' };
import { ProviderError, type CricketProvider } from '../adapter.js';
import { normalizeCountry } from '../normalizers/series.js';
import type { BallEvent, Country, Innings, MatchResult, PlayerProfile, ProviderCapabilities, ProviderMatch, ScoreTick, SeriesInfo, Squad } from '../types.js';
import { syntheticProfile } from './playerStats.js';
import { replayScripts } from './scripts.js';
import { resolve, type ReplaySessionStore, type ResolvedSession } from './sessions.js';
import { replaySeriesId, viewAt } from './state.js';

/**
 * Plays recorded/synthesized matches ball by ball, driven by ReplaySessionStore.advanceAll().
 * Exposes exactly the same CricketProvider contract as the live provider.
 */
export class ReplayProvider implements CricketProvider {
  readonly source = 'replay' as const;

  constructor(private readonly store: ReplaySessionStore) {}

  capabilities(): ProviderCapabilities {
    return { ballByBall: true, scorecard: true, toss: true, squads: true, playerStats: true };
  }

  private async resolved(providerId: string): Promise<ResolvedSession> {
    const session = await this.store.getByProviderId(providerId);
    const r = session ? resolve(session) : null;
    if (!r) throw new ProviderError('NOT_FOUND', `replay match ${providerId} not found`);
    if (r.session.outage) throw new ProviderError('UNAVAILABLE', 'simulated provider outage', true);
    return r;
  }

  async getMatches(): Promise<ProviderMatch[]> {
    const sessions = await this.store.list(100);
    return sessions
      .filter((s) => !s.outage)
      .map((s) => resolve(s))
      .filter((r): r is ResolvedSession => r !== null)
      .map((r) => viewAt(r).match);
  }

  async getMatchDetail(providerId: string): Promise<ProviderMatch> {
    return viewAt(await this.resolved(providerId)).match;
  }

  async getLiveScore(): Promise<ScoreTick[]> {
    const sessions = await this.store.list(100);
    return sessions
      .filter((s) => !s.outage)
      .map((s) => ({
        providerId: s.providerId,
        phase: s.cursor < 0 ? ('fixture' as const) : s.status === 'finished' ? ('result' as const) : ('live' as const),
        fingerprint: [s.status, s.cursor, s.pauseReason ?? '', s.abandoned ? 'A' : ''].join('|'),
      }));
  }

  async getBallByBall(providerId: string): Promise<BallEvent[]> {
    const now = new Date();
    return viewAt(await this.resolved(providerId)).balls.map((b) => ({ ...b, occurredAt: now }));
  }

  async getScorecard(providerId: string): Promise<Innings[]> {
    return viewAt(await this.resolved(providerId)).match.innings;
  }

  async getSquads(ref: { providerId: string; seriesProviderId: string | null }): Promise<Squad[]> {
    const r = await this.resolved(ref.providerId);
    return r.script.teams.map((team) => ({ team, players: r.script.squads[team.key] ?? [] }));
  }

  getPlayerStats(playerId: string): Promise<PlayerProfile> {
    for (const script of replayScripts()) {
      for (const squad of Object.values(script.squads)) {
        const player = squad.find((p) => p.playerId === playerId);
        if (player) return Promise.resolve(syntheticProfile(player));
      }
    }
    return Promise.reject(new ProviderError('NOT_FOUND', `replay player ${playerId} not found`));
  }

  async getResult(providerId: string): Promise<MatchResult | null> {
    return (await this.getMatchDetail(providerId)).result;
  }

  getSeries(): Promise<SeriesInfo[]> {
    const byId = new Map<string, SeriesInfo>();
    for (const s of replayScripts()) {
      const id = replaySeriesId(s.seriesName);
      if (!id || !s.seriesName) continue;
      const entry = byId.get(id) ?? { providerId: id, name: s.seriesName, startDate: null, endDate: null, fixtureCounts: { odi: 0, t20: 0, test: 0, total: 0 }, squadsAnnounced: 0, isShadow: false };
      entry.fixtureCounts.total += 1;
      if (s.format === 'ODI') entry.fixtureCounts.odi += 1;
      else if (s.format === 'TEST') entry.fixtureCounts.test += 1;
      else entry.fixtureCounts.t20 += 1;
      byId.set(id, entry);
    }
    return Promise.resolve([...byId.values()]);
  }

  getCountries(): Promise<Country[]> {
    return Promise.resolve(countries.map(normalizeCountry));
  }
}
