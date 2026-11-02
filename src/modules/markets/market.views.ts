import type { IMarket } from './market.model.js';
import type { MarketBook } from './liability.js';

export interface SelectionView {
  id: string;
  name: string;
  odds: number;
  status: IMarket['selections'][number]['status'];
  teamKey: string | null;
  playerId: string | null;
}

/** What users see. No fair probabilities, margins or liability. */
export interface MarketView {
  id: string;
  matchId: string;
  type: IMarket['type'];
  key: string;
  group: IMarket['group'];
  name: string;
  status: IMarket['status'];
  suspendReason: IMarket['suspendReason'];
  inPlay: boolean;
  line: string | null;
  lineX10: number | null;
  selections: SelectionView[];
  betDelayMs: number;
  minStake: number;
  maxStake: number;
  sortOrder: number;
  result: IMarket['result'];
  version: number;
  updatedAt: Date;
}

export interface AdminMarketView extends MarketView {
  marginBps: number;
  maxLiability: number;
  autoManaged: boolean;
  params: IMarket['params'];
  probabilitiesBps: Record<string, number>;
  book: MarketBook | null;
  createdBy: string;
}

export function toMarketView(m: IMarket): MarketView {
  return {
    id: m._id.toString(),
    matchId: m.matchId.toString(),
    type: m.type,
    key: m.key,
    group: m.group,
    name: m.name,
    status: m.status,
    suspendReason: m.suspendReason,
    inPlay: m.inPlay,
    line: m.lineX10 === null ? null : (m.lineX10 / 10).toFixed(1),
    lineX10: m.lineX10,
    selections: m.selections.map((s) => ({ id: s.id, name: s.name, odds: s.odds, status: s.status, teamKey: s.teamKey, playerId: s.playerId })),
    betDelayMs: m.betDelayMs,
    minStake: m.minStake,
    maxStake: m.maxStake,
    sortOrder: m.sortOrder,
    result: m.result,
    version: m.version,
    updatedAt: m.updatedAt,
  };
}

export function toAdminMarketView(m: IMarket, book: MarketBook | null): AdminMarketView {
  return {
    ...toMarketView(m),
    marginBps: m.marginBps,
    maxLiability: m.maxLiability,
    autoManaged: m.autoManaged,
    params: m.params,
    probabilitiesBps: Object.fromEntries(m.selections.map((s) => [s.id, s.probabilityBps])),
    book,
    createdBy: m.createdBy,
  };
}
