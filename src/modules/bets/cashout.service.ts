import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import { withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { getRedis } from '../../config/redis.js';
import { safeEqual } from '../../utils/crypto.js';
import { AppError } from '../../utils/errors.js';
import { addExposure } from '../markets/liability.js';
import { Market, type IMarket } from '../markets/market.model.js';
import { Match } from '../matches/match.model.js';
import { getSettings } from '../settings/settings.service.js';
import { availableAccount, lockedAccount } from '../wallet/accounts.js';
import { notifyWalletChanged, transferInSession } from '../wallet/ledger.service.js';
import { Bet, type IBet } from './bet.model.js';
import { toBetView, type BetView } from './bet.views.js';
import { cashoutOffer } from './math.js';
import { announce } from './placement.service.js';
import { marketBlock } from './validation.js';
import { notify, tokens } from '../notifications/notifications.service.js';

const QUOTE_TTL_MS = 10_000;
const CASHOUT_MARKETS = new Set(['MATCH_WINNER']);
const secret = createHmac('sha256', env.JWT_ACCESS_SECRET).update('cashout-quote-v1').digest();

interface QuotePayload {
  betId: string;
  userId: string;
  amount: number;
  marketVersion: number;
  exp: number;
}

function sign(p: QuotePayload): string {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function verify(token: string): QuotePayload {
  const [body, mac] = token.split('.');
  if (!body || !mac || !safeEqual(mac, createHmac('sha256', secret).update(body).digest('base64url'))) {
    throw new AppError('QUOTE_EXPIRED', 'Cash-out quote is invalid; request a new one');
  }
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as QuotePayload;
  if (p.exp < Date.now()) throw new AppError('QUOTE_EXPIRED', 'Cash-out quote expired; request a new one');
  return p;
}

async function eligible(userId: string, betId: string): Promise<{ bet: IBet; market: IMarket; currentOdds: number }> {
  if (!Types.ObjectId.isValid(betId)) throw AppError.notFound('Bet');
  const bet = await Bet.findOne({ _id: betId, userId: new Types.ObjectId(userId) }).lean();
  if (!bet) throw AppError.notFound('Bet');
  const leg = bet.legs[0];
  if (bet.status !== 'ACCEPTED' || bet.kind !== 'SINGLE' || !leg) throw new AppError('CASHOUT_UNAVAILABLE', 'Cash out is only available on open single bets');
  if (!CASHOUT_MARKETS.has(leg.marketType)) throw new AppError('CASHOUT_UNAVAILABLE', 'Cash out is only available on Match Winner bets');
  const market = await Market.findById(leg.marketId).lean();
  if (!market) throw AppError.notFound('Market');
  const match = await Match.findById(market.matchId).select('bettingEnabled').lean();
  const block = marketBlock(market, match ?? undefined);
  if (block) throw new AppError('CASHOUT_UNAVAILABLE', 'Cash out is unavailable while the market is not open', { reason: block.code });
  const sel = market.selections.find((s) => s.id === leg.selectionId);
  if (!sel || sel.status !== 'ACTIVE') throw new AppError('CASHOUT_UNAVAILABLE', 'Selection is no longer available');
  return { bet, market, currentOdds: sel.odds };
}

export interface CashoutQuote {
  betId: string;
  amount: number;
  stake: number;
  placedOdds: number;
  currentOdds: number;
  expiresAt: Date;
  quoteToken: string;
}

export async function getCashoutQuote(userId: string, betId: string): Promise<CashoutQuote> {
  const { bet, market, currentOdds } = await eligible(userId, betId);
  const settings = await getSettings();
  const placedOdds = bet.legs[0]!.odds;
  const amount = cashoutOffer(bet.stake, placedOdds, currentOdds, settings.cashoutMarginBps);
  const exp = Date.now() + QUOTE_TTL_MS;
  return {
    betId, amount, stake: bet.stake, placedOdds, currentOdds, expiresAt: new Date(exp),
    quoteToken: sign({ betId, userId, amount, marketVersion: market.version, exp }),
  };
}

/** Executes a quote: single-use, only while the market is open and its prices haven't changed since. */
export async function executeCashout(userId: string, betId: string, quoteToken: string): Promise<BetView> {
  const q = verify(quoteToken);
  if (q.betId !== betId || q.userId !== userId) throw new AppError('QUOTE_EXPIRED', 'Quote does not match this bet');
  // Retrying a cash-out that already went through (lost response) returns the same result.
  const prior = await Bet.findOne({ _id: betId, userId: new Types.ObjectId(userId), status: 'CASHED_OUT' }).lean();
  if (prior?.cashout?.amount === q.amount) return toBetView(prior);
  const { bet, market } = await eligible(userId, betId);
  if (market.version !== q.marketVersion) throw new AppError('ODDS_CHANGED', 'Prices moved since your quote; request a new one');
  const used = await getRedis().set(`cashout:used:${quoteToken.slice(-43)}`, '1', 'PX', QUOTE_TTL_MS * 2, 'NX');
  if (used !== 'OK') throw new AppError('DUPLICATE_REQUEST', 'This quote was already used');

  const now = new Date();
  const settled = await withTransaction(async (session) => {
    // Re-check inside the transaction: the market must still be at the quoted version.
    const fresh = await Market.findById(market._id).select('version status').session(session).lean();
    if (!fresh || fresh.status !== 'OPEN' || fresh.version !== q.marketVersion) throw new AppError('ODDS_CHANGED', 'Prices moved since your quote; request a new one');
    const updated = await Bet.findOneAndUpdate(
      { _id: bet._id, status: 'ACCEPTED' },
      { $set: { status: 'CASHED_OUT', payout: q.amount, cashout: { amount: q.amount, at: now }, settledAt: now }, $inc: { version: 1 } },
      { new: true, lean: true, session },
    );
    if (!updated) throw new AppError('INVALID_STATE', 'Bet is no longer open');
    await transferInSession({ from: lockedAccount(userId), to: 'house', amount: bet.stake, type: 'BET_STAKE_CAPTURE', idempotencyKey: `cashout:${betId}:capture`, ref: { type: 'bet', id: betId } }, session);
    await transferInSession({ from: 'house', to: availableAccount(userId), amount: q.amount, type: 'CASHOUT', idempotencyKey: `cashout:${betId}:payout`, ref: { type: 'bet', id: betId } }, session);
    return updated;
  });
  const leg = settled.legs[0]!;
  await addExposure(leg.marketId.toString(), leg.selectionId, bet.stake, bet.potentialReturn, -1);
  await notifyWalletChanged([userId], 'CASHOUT');
  await announce(settled, 'cashed_out');
  await notify({ userId, type: 'CASHOUT', title: 'Exited bet early', body: `${leg.selectionName}: ${tokens(q.amount)} added to your wallet.`, data: { betId, amount: q.amount }, dedupeKey: `cashout:${betId}` });
  return toBetView(settled);
}
