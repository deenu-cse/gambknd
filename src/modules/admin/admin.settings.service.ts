import { withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { getSettings, invalidateSettingsCache, updateSettings, type PlatformSettings, type SettingsPatch } from '../settings/settings.service.js';
import type { SettingsPatchBody } from './admin.schema.js';

/** Only what changed goes in the audit row, so a one-field edit reads as one field. */
function changed(before: PlatformSettings, patch: SettingsPatch) {
  const keys = (Object.keys(patch) as Array<keyof SettingsPatch>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(patch[k]));
  return { before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: Object.fromEntries(keys.map((k) => [k, patch[k]])) };
}

export async function patchSettings(actor: AuditActor & { id: string }, body: SettingsPatchBody): Promise<PlatformSettings> {
  const { reason, ...fields } = body;
  const patch = fields as SettingsPatch;
  const current = await getSettings();
  const min = patch.globalMinStake ?? current.globalMinStake;
  const max = patch.globalMaxStake ?? current.globalMaxStake;
  if (min > max) throw new AppError('VALIDATION_ERROR', 'Minimum stake cannot exceed the maximum stake', [{ path: 'globalMinStake', message: 'must not exceed the maximum stake' }]);
  if (patch.providerMode === 'live' && !env.CRICAPI_KEY) throw new AppError('INVALID_STATE', 'Live mode needs CRICAPI_KEY on the server');

  const after = await withTransaction(async (session) => {
    const result = await updateSettings(patch, actor.id, session);
    await recordAudit(actor, { action: 'settings.update', targetType: 'settings', targetId: 'global', reason, ...changed(result.before, patch) }, session);
    return result.after;
  });
  // A read during the transaction may have re-cached the old values.
  invalidateSettingsCache();
  return after;
}
