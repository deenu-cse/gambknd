import { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { providerFor, ProviderError } from '../../providers/cricket/index.js';
import type { DataSource, Squad } from '../../providers/cricket/types.js';
import { AppError } from '../../utils/errors.js';
import { withLock } from '../../utils/lock.js';
import { Player, Series, type IPlayer } from './catalog.models.js';
import { Match, type IMatch } from './match.model.js';

const SQUAD_TTL_MS = 24 * 3600 * 1000;
const STATS_TTL_MS = 7 * 24 * 3600 * 1000;

export async function upsertPlayers(squads: readonly Squad[], source: DataSource): Promise<void> {
  const ops = squads.flatMap((s) =>
    s.players.map((p) => ({
      updateOne: {
        filter: { pid: p.playerId },
        update: {
          $setOnInsert: { pid: p.playerId, source, stats: null, statsSyncedAt: null, placeOfBirth: null, dateOfBirth: null },
          $set: { name: p.name, role: p.role, battingStyle: p.battingStyle, bowlingStyle: p.bowlingStyle, bowlingType: p.bowlingType, country: p.country, imageUrl: p.imageUrl },
          $addToSet: { teamKeys: s.team.key },
        },
        upsert: true,
      },
    })),
  );
  if (ops.length > 0) await Player.bulkWrite(ops, { ordered: false });
}

/** Squads for a match, fetched from the provider at most once a day (each fetch costs a hit in live mode). */
export async function ensureSquads(matchId: string): Promise<IMatch['squads']> {
  if (!Types.ObjectId.isValid(matchId)) throw AppError.notFound('Match');
  const match = await Match.findById(matchId).lean();
  if (!match) throw AppError.notFound('Match');
  const fresh = match.squadsSyncedAt && Date.now() - match.squadsSyncedAt.getTime() < SQUAD_TTL_MS;
  if (fresh && match.squads.length > 0) return match.squads;

  return withLock(
    `squads:${matchId}`,
    15_000,
    async () => {
      const provider = providerFor(match.source);
      if (!provider) return match.squads;
      let squads: Squad[] = [];
      try {
        squads = await provider.getSquads({ providerId: match.providerRef.id, seriesProviderId: await seriesProviderId(match) });
      } catch (err) {
        if (err instanceof ProviderError) {
          logger.warn({ matchId, kind: err.kind }, 'squad fetch failed; serving cached squads');
          return match.squads;
        }
        throw err;
      }
      // series_squad returns every team in the series; keep only this match's two sides.
      const keys = new Set(match.teams.map((t) => t.key));
      const relevant = squads.filter((s) => keys.has(s.team.key));
      await upsertPlayers(relevant, match.source);
      const stored = relevant.map((s) => ({ teamKey: s.team.key, players: s.players }));
      await Match.updateOne({ _id: match._id }, { $set: { squads: stored, squadsSyncedAt: new Date() } });
      return stored;
    },
    () => match.squads,
  );
}

async function seriesProviderId(match: Pick<IMatch, 'seriesId'>): Promise<string | null> {
  if (!match.seriesId) return null;
  const s = await Series.findById(match.seriesId).select('providerRef').lean();
  return s?.providerRef.id ?? null;
}

export interface PlayerView {
  id: string;
  source: DataSource;
  name: string;
  role: IPlayer['role'];
  battingStyle: IPlayer['battingStyle'];
  bowlingStyle: string | null;
  bowlingType: IPlayer['bowlingType'];
  country: string | null;
  imageUrl: string | null;
  teamKeys: string[];
  placeOfBirth: string | null;
  dateOfBirth: Date | null;
  stats: IPlayer['stats'];
  statsSyncedAt: Date | null;
}

export function toPlayerView(p: IPlayer): PlayerView {
  return {
    id: p.pid,
    source: p.source,
    name: p.name,
    role: p.role,
    battingStyle: p.battingStyle,
    bowlingStyle: p.bowlingStyle,
    bowlingType: p.bowlingType,
    country: p.country,
    imageUrl: p.imageUrl,
    teamKeys: p.teamKeys,
    placeOfBirth: p.placeOfBirth,
    dateOfBirth: p.dateOfBirth,
    stats: p.stats,
    statsSyncedAt: p.statsSyncedAt,
  };
}

/** Player profile; career stats refreshed from the provider when older than 7 days. */
export async function getPlayer(pid: string): Promise<PlayerView> {
  const player = await Player.findOne({ pid }).lean();
  if (!player) throw AppError.notFound('Player');
  const stale = !player.statsSyncedAt || Date.now() - player.statsSyncedAt.getTime() > STATS_TTL_MS;
  if (!stale) return toPlayerView(player);

  const provider = providerFor(player.source);
  if (!provider) return toPlayerView(player);
  try {
    const profile = await provider.getPlayerStats(pid);
    const updated = await Player.findOneAndUpdate(
      { pid },
      { $set: { stats: profile.stats, statsSyncedAt: new Date(), placeOfBirth: profile.placeOfBirth, dateOfBirth: profile.dateOfBirth, role: profile.role } },
      { new: true, lean: true },
    );
    return toPlayerView(updated ?? player);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    logger.warn({ pid, kind: err.kind }, 'player stats refresh failed; serving cached');
    return toPlayerView(player);
  }
}

export async function searchPlayers(q: string, limit: number): Promise<PlayerView[]> {
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const rows = await Player.find({ name: rx }).limit(limit).lean();
  return rows.map(toPlayerView);
}
