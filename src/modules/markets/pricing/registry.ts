import type { AutoMarketType } from '../types.js';
import type { MarketDefinition } from './definition.js';
import { matchWinnerDefinition } from './matchWinner.js';
import { partnershipDefinition } from './partnership.js';
import { playersDefinition } from './players.js';
import { totalsDefinition } from './totals.js';
import { wicketsDefinition } from './wickets.js';

export const DEFINITIONS: readonly MarketDefinition[] = [matchWinnerDefinition, totalsDefinition, wicketsDefinition, playersDefinition, partnershipDefinition];

const byType = new Map<AutoMarketType, MarketDefinition>(DEFINITIONS.flatMap((d) => d.types.map((t) => [t, d] as const)));

export function definitionFor(type: AutoMarketType): MarketDefinition {
  const d = byType.get(type);
  if (!d) throw new Error(`no market definition for ${type}`);
  return d;
}
