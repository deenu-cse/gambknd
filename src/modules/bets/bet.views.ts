import type { IBet } from './bet.model.js';

export interface BetView {
  id: string;
  kind: IBet['kind'];
  status: IBet['status'];
  stake: number;
  odds: number;
  potentialReturn: number;
  payout: number;
  legs: Array<{
    matchId: string;
    marketId: string;
    selectionId: string;
    matchTitle: string;
    marketType: string;
    marketName: string;
    selectionName: string;
    line: string | null;
    odds: number;
    requestedOdds: number;
    inPlay: boolean;
    result: IBet['legs'][number]['result'];
  }>;
  placedAt: Date;
  acceptAt: Date | null;
  acceptedAt: Date | null;
  settledAt: Date | null;
  rejectReason: string | null;
  voidReason: string | null;
  cashout: IBet['cashout'];
}

export function toBetView(b: IBet): BetView {
  return {
    id: b._id.toString(),
    kind: b.kind,
    status: b.status,
    stake: b.stake,
    odds: b.odds,
    potentialReturn: b.potentialReturn,
    payout: b.payout,
    legs: b.legs.map((l) => ({
      matchId: l.matchId.toString(),
      marketId: l.marketId.toString(),
      selectionId: l.selectionId,
      matchTitle: l.matchTitle,
      marketType: l.marketType,
      marketName: l.marketName,
      selectionName: l.selectionName,
      line: l.lineX10 === null ? null : (l.lineX10 / 10).toFixed(1),
      odds: l.odds,
      requestedOdds: l.requestedOdds,
      inPlay: l.inPlay,
      result: l.result,
    })),
    placedAt: b.placedAt,
    acceptAt: b.acceptAt,
    acceptedAt: b.acceptedAt,
    settledAt: b.settledAt,
    rejectReason: b.rejectReason,
    voidReason: b.voidReason,
    cashout: b.cashout,
  };
}

export interface AdminBetView extends BetView {
  userId: string;
  ip: string | null;
}

export function toAdminBetView(b: IBet): AdminBetView {
  return { ...toBetView(b), userId: b.userId.toString(), ip: b.ip };
}
