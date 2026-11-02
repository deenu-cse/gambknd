import type { ClientSession } from 'mongoose';
import { env } from '../../config/env.js';
import { DEFAULT_SETTINGS, Settings, type ISettings } from './settings.model.js';

export type PlatformSettings = Omit<ISettings, '_id' | 'defaultMarginsBps'> & { defaultMarginsBps: Record<string, number> };

const CACHE_TTL_MS = 5_000;
let cache: { value: PlatformSettings; at: number } | undefined;

function toPlain(doc: ISettings & { defaultMarginsBps: unknown }): PlatformSettings {
  const margins = doc.defaultMarginsBps instanceof Map ? Object.fromEntries(doc.defaultMarginsBps as Map<string, number>) : doc.defaultMarginsBps;
  return {
    welcomeBonus: doc.welcomeBonus,
    dailyBonus: doc.dailyBonus,
    defaultMarginsBps: { ...DEFAULT_SETTINGS.defaultMarginsBps, ...margins },
    defaultBetDelayMs: doc.defaultBetDelayMs,
    marketReopenDelayMs: doc.marketReopenDelayMs,
    globalMinStake: doc.globalMinStake,
    globalMaxStake: doc.globalMaxStake,
    defaultMaxLiability: doc.defaultMaxLiability,
    cashoutMarginBps: doc.cashoutMarginBps,
    adminMaxAdjustment: doc.adminMaxAdjustment,
    staleThresholdMs: doc.staleThresholdMs,
    marketTypesEnabled: doc.marketTypesEnabled ?? DEFAULT_SETTINGS.marketTypesEnabled,
    oneSidedThresholdBps: doc.oneSidedThresholdBps ?? DEFAULT_SETTINGS.oneSidedThresholdBps,
    shadingStartBps: doc.shadingStartBps ?? DEFAULT_SETTINGS.shadingStartBps,
    shadingMaxBoostBps: doc.shadingMaxBoostBps ?? DEFAULT_SETTINGS.shadingMaxBoostBps,
    maintenance: { enabled: doc.maintenance.enabled, message: doc.maintenance.message },
    providerMode: doc.providerMode,
    version: doc.version,
    updatedBy: doc.updatedBy,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Returns the settings singleton, creating it with defaults on first use. Cached for 5s per process.
 * Reads only: the upsert runs outside any transaction, so hot paths never contend on this document.
 */
export async function getSettings(session?: ClientSession): Promise<PlatformSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  let doc = await Settings.findById('global', null, session ? { session } : {}).lean();
  if (!doc) {
    try {
      doc = await Settings.findOneAndUpdate(
        { _id: 'global' },
        { $setOnInsert: { ...DEFAULT_SETTINGS, providerMode: env.CRICKET_PROVIDER, version: 0, updatedBy: null } },
        { upsert: true, new: true, lean: true },
      );
    } catch (err) {
      // Two processes creating the singleton at once: the loser hits a duplicate _id and re-reads.
      if ((err as { code?: number }).code !== 11000) throw err;
      doc = await Settings.findById('global').lean();
    }
  }
  if (!doc) throw new Error('settings singleton missing');
  const value = toPlain(doc);
  cache = { value, at: Date.now() };
  return value;
}

export type SettingsPatch = Partial<Omit<PlatformSettings, 'version' | 'updatedBy' | 'updatedAt'>>;

export async function updateSettings(patch: SettingsPatch, actorId: string, session?: ClientSession): Promise<{ before: PlatformSettings; after: PlatformSettings }> {
  const before = await getSettings(session);
  const set: Record<string, unknown> = { updatedBy: actorId };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'defaultMarginsBps' && value) {
      for (const [type, bps] of Object.entries(value as Record<string, number>)) set[`defaultMarginsBps.${type}`] = bps;
    } else if (value !== undefined) {
      set[key] = value;
    }
  }
  const doc = await Settings.findOneAndUpdate({ _id: 'global' }, { $set: set, $inc: { version: 1 } }, { new: true, lean: true, ...(session ? { session } : {}) });
  cache = undefined;
  return { before, after: toPlain(doc as ISettings) };
}

export function invalidateSettingsCache(): void {
  cache = undefined;
}
