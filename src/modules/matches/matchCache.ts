import { Types } from 'mongoose';
import { getRedis } from '../../config/redis.js';
import { Match } from './match.model.js';
import { toLiveView, type MatchLiveView } from './match.views.js';

const key = (id: string): string => `match:${id}:state`;
const TTL_SEC = 24 * 3600;

/** Written by the sync service after every change; REST reads come from here first. */
export async function cacheLiveView(view: MatchLiveView): Promise<void> {
  await getRedis().set(key(view.id), JSON.stringify(view), 'EX', TTL_SEC);
}

export async function invalidateLiveView(id: string): Promise<void> {
  await getRedis().del(key(id));
}

/** Redis first, Mongo fallback (and re-cache). null if the match doesn't exist. */
export async function getLiveView(id: string): Promise<MatchLiveView | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  const cached = await getRedis().get(key(id));
  if (cached) return JSON.parse(cached) as MatchLiveView;
  const doc = await Match.findById(id).lean();
  if (!doc) return null;
  const view = toLiveView(doc);
  await cacheLiveView(view);
  return view;
}
