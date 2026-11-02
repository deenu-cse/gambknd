import type { RawBall, RawScorecardInnings } from '../live/schemas.js';
import type { BallEvent, BatterLine, BowlerLine, DismissalKind, Innings } from '../types.js';
import { normalizeTeamKey, oversToBalls } from './text.js';

// [UNSAMPLED] Both endpoints here follow the provider's public docs (ASSUMPTIONS A-16).
// Everything is defensive: unknown shapes produce empty lines rather than exceptions.

function playerId(ref: { id?: string | undefined; name: string } | undefined): string {
  if (!ref) return 'unknown';
  return ref.id && ref.id.length > 0 ? ref.id : `name:${normalizeTeamKey(ref.name)}`;
}

function isNotOut(text: string | undefined): boolean {
  return !text || /not out|batting|^\s*$/i.test(text);
}

/** Merges per-innings batting/bowling/extras into innings already built from score[] (same order). */
export function mergeScorecard(innings: Innings[], raw: readonly RawScorecardInnings[]): Innings[] {
  return innings.map((inn, idx) => {
    const card = raw[idx];
    if (!card) return inn;
    const batting: BatterLine[] = card.batting.map((b) => ({
      playerId: playerId(b.batsman),
      name: b.batsman.name,
      runs: b.r,
      balls: b.b,
      fours: b['4s'],
      sixes: b['6s'],
      dismissal: isNotOut(b['dismissal-text']) ? null : (b['dismissal-text'] ?? null),
      isOut: !isNotOut(b['dismissal-text']),
    }));
    const bowling: BowlerLine[] = card.bowling.map((b) => ({
      playerId: playerId(b.bowler),
      name: b.bowler.name,
      balls: oversToBalls(b.o),
      maidens: b.m,
      runs: b.r,
      wickets: b.w,
      wides: b.wd,
      noBalls: b.nb,
    }));
    const e = card.extras;
    const extras = e
      ? {
          wides: e.w ?? 0,
          noBalls: e.nb ?? 0,
          byes: e.b ?? 0,
          legByes: e.lb ?? 0,
          penalty: e.p ?? 0,
          total: e.r ?? (e.w ?? 0) + (e.nb ?? 0) + (e.b ?? 0) + (e.lb ?? 0) + (e.p ?? 0),
        }
      : inn.extras;
    return { ...inn, batting, bowling, extras };
  });
}

export function dismissalKindOf(text: string): DismissalKind {
  const t = text.trim().toLowerCase();
  if (/run ?out/.test(t)) return 'RUN_OUT';
  if (/^st\b|stumped/.test(t)) return 'STUMPED';
  if (/lbw/.test(t)) return 'LBW';
  if (/hit wicket/.test(t)) return 'HIT_WICKET';
  if (/^c\b|caught|catch|c&b|c & b/.test(t)) return 'CAUGHT';
  if (/^b\b|bowled/.test(t)) return 'BOWLED';
  return 'OTHER';
}

function extrasOf(b: RawBall): BallEvent['extras'] {
  const type = (b.extrasType ?? b.extraType ?? '').toLowerCase();
  const x = { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalty: 0 };
  const amount = b.extras || (type ? 1 : 0);
  if (!type || amount === 0) return x;
  if (/^w|wide/.test(type)) x.wides = amount;
  else if (/^nb|no/.test(type)) x.noBalls = amount;
  else if (/^lb|leg/.test(type)) x.legByes = amount;
  else if (/^b|bye/.test(type)) x.byes = amount;
  else if (/^p|pen/.test(type)) x.penalty = amount;
  return x;
}

function wicketOf(b: RawBall, striker: { id: string; name: string }): BallEvent['wicket'] {
  const text = b.dismissal ?? (typeof b.wicket === 'string' ? b.wicket : '');
  const isWicket = (b.wicket === true || (text !== '' && !isNotOut(text)));
  if (!isWicket) return null;
  const out = b.playerOut ? { id: playerId(b.playerOut), name: b.playerOut.name } : striker;
  const fielder = b.catcher ?? b.fielder;
  return { kind: dismissalKindOf(text || 'other'), playerOutId: out.id, playerOutName: out.name, fielderName: fielder?.name ?? null };
}

/** match_bbb rows → BallEvents. Legal-ball counts, crease and running score are recomputed, never trusted. */
export function normalizeBalls(raw: readonly RawBall[]): BallEvent[] {
  if (raw.length === 0) return [];
  const zeroBasedInnings = raw.some((b) => b.inning === 0);
  const zeroBasedOvers = raw.some((b) => b.over === 0);
  const ordered = [...raw].sort((a, b) => (a.n ?? 0) - (b.n ?? 0) || a.inning - b.inning || a.over - b.over || a.ball - b.ball);

  const out: BallEvent[] = [];
  const state = new Map<number, { runs: number; wickets: number; legal: number; seq: number; crease: string[]; legalInOver: Map<number, number> }>();
  for (const b of ordered) {
    const innings = b.inning + (zeroBasedInnings ? 1 : 0);
    const over = Math.max(0, b.over - (zeroBasedOvers ? 0 : 1));
    const st = state.get(innings) ?? { runs: 0, wickets: 0, legal: 0, seq: 0, crease: [], legalInOver: new Map<number, number>() };
    state.set(innings, st);

    const strikerRef = b.batsman ?? b.batter;
    const striker = { id: playerId(strikerRef), name: strikerRef?.name ?? 'Unknown' };
    const bowler = { id: playerId(b.bowler), name: b.bowler?.name ?? 'Unknown' };
    if (!st.crease.includes(striker.id)) st.crease = [striker.id, ...st.crease.filter((p) => p !== striker.id)].slice(0, 2);
    const nonStriker = b.nonStriker ? playerId(b.nonStriker) : (st.crease.find((p) => p !== striker.id) ?? 'unknown');

    const extras = extrasOf(b);
    const isLegal = extras.wides === 0 && extras.noBalls === 0;
    const legalSoFar = (st.legalInOver.get(over) ?? 0) + (isLegal ? 1 : 0);
    st.legalInOver.set(over, legalSoFar);
    const totalRuns = b.runs + extras.wides + extras.noBalls + extras.byes + extras.legByes + extras.penalty;
    const wicket = wicketOf(b, striker);

    st.seq += 1;
    st.runs += totalRuns;
    if (isLegal) st.legal += 1;
    if (wicket) {
      st.wickets += 1;
      st.crease = st.crease.filter((p) => p !== wicket.playerOutId);
    }

    out.push({
      innings,
      over,
      ballInOver: Math.max(1, Math.min(6, legalSoFar || 1)),
      seq: st.seq,
      batterId: striker.id,
      batterName: striker.name,
      nonStrikerId: nonStriker,
      bowlerId: bowler.id,
      bowlerName: bowler.name,
      runsBat: b.runs,
      extras,
      totalRuns,
      isLegal,
      isBoundary: b.runs === 4 || b.runs === 6,
      wicket,
      commentary: b.commentary ?? b.comment ?? b.text ?? `${bowler.name} to ${striker.name}, ${wicket ? 'OUT' : `${totalRuns} run${totalRuns === 1 ? '' : 's'}`}`,
      scoreAfter: { runs: st.runs, wickets: st.wickets, balls: st.legal },
      occurredAt: new Date(),
    });
  }
  return out;
}
