import type { Holding, Portfolio } from '../../../shared/api-types';
import { config } from '../config';
import { leagueTradeDate, marketDate, sessionBounds } from '../market/calendar';
import { fxAt, getFx } from '../market/fx';
import { getQuote } from '../market/quoteCache';
import { getSymbol } from '../market/symbols';
import { now } from '../lib/time';
import { convertsFx, ratesFor, roundMoney, tradeCost } from './fees';
import { EngineError } from './errors';
import {
  getHoldings,
  getLeagueRow,
  getParticipantRow,
  lastSnapshot,
  type HoldingRow,
  reservePrice,
  sql,
  type LeagueRow,
  type OrderRow,
  type ParticipantRow,
} from './store';

function load(participantId: number): { participant: ParticipantRow; league: LeagueRow } {
  const participant = getParticipantRow(participantId);
  const league = participant && getLeagueRow(participant.league_id);
  if (!participant || !league) throw new EngineError('not_found', '참가 정보를 찾을 수 없습니다.');
  return { participant, league };
}

/** Last quote price, or the average cost when the symbol has no quote yet. */
function markPrice(symbol: string, avgPrice: number): number {
  return getQuote(symbol)?.price ?? avgPrice;
}

/** Last stored price at or before `ts` (the quotes table keeps one row per symbol per minute). */
function storedPriceAt(symbol: string, ts: number): number | undefined {
  return sql('SELECT price FROM quotes WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').pluck().get(symbol, ts) as
    | number
    | undefined;
}

/**
 * Rate converting a holding's native price into the league currency: the USD/KRW mid for US
 * symbols in ALL leagues (even when stale; the cost-basis rate before any rate exists), else 1.
 */
function markFx(league: LeagueRow, h: HoldingRow, mid: number | undefined = getFx()?.rate): number {
  if (!convertsFx(league.market, h.symbol)) return 1;
  return mid ?? h.avg_fx;
}

/** A league that finishes late is valued as of `endAt`, from prices dated up to `cutoff` (see settledPrice). */
export interface Settlement {
  endAt: number;
  cutoff: number;
  /** USD/KRW mid to value US holdings of ALL leagues at; the live mid when omitted. */
  mid?: number;
}

/** Close of the last session of `symbol` that ended at or before `endAt`, from daily_bars. */
function closingBar(symbol: string, endAt: number): { ts: number; price: number } | undefined {
  const market = getSymbol(symbol)?.market;
  if (!market) return undefined;
  const bars = sql('SELECT date, close FROM daily_bars WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 3').all(
    symbol,
    marketDate(market, endAt),
  ) as { date: string; close: number }[];
  for (const bar of bars) {
    const { close } = sessionBounds(market, bar.date);
    if (close <= endAt) return { ts: close, price: bar.close };
  }
  return undefined;
}

/**
 * Price of `symbol` as of a league end the server missed (it was off at end_at, so the quote
 * cache already holds a later session): the last stored quote up to `cutoff`, or the daily close
 * of the last session that ended by `endAt` when that is newer. A close taken from daily_bars is
 * written to `quotes` at its session close, so getPortfolio() later reads the very same price.
 * undefined when neither exists.
 */
export function settledPrice(symbol: string, { endAt, cutoff }: Pick<Settlement, 'endAt' | 'cutoff'>): number | undefined {
  const stored = sql('SELECT ts, price FROM quotes WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').get(symbol, cutoff) as
    | { ts: number; price: number }
    | undefined;
  const bar = closingBar(symbol, endAt);
  if (bar && (!stored || stored.ts < bar.ts)) {
    sql('INSERT OR REPLACE INTO quotes (symbol, ts, price, volume, source) VALUES (?, ?, ?, 0, ?)').run(
      symbol,
      Math.floor(bar.ts / 60_000) * 60_000, // quotes keeps one row per minute
      bar.price,
      config.priceProvider === 'sim' ? 'sim' : 'yahoo',
    );
    return bar.price;
  }
  return stored?.price;
}

/**
 * Cash plus holdings marked to the last quote (US holdings of ALL leagues at the USD/KRW mid).
 * With `settle`, holdings are marked to settledPrice() instead (the last quote only for symbols
 * with no price on record) and US holdings at `settle.mid`.
 */
export function equityOf(participantId: number, settle?: Settlement): number {
  const { participant, league } = load(participantId);
  const value = getHoldings(participantId).reduce((sum, h) => {
    const price = (settle && settledPrice(h.symbol, settle)) ?? markPrice(h.symbol, h.avg_price);
    return sum + h.quantity * price * markFx(league, h, settle?.mid ?? getFx()?.rate);
  }, 0);
  return roundMoney(league.currency, participant.cash + value);
}

/** Sum of the cash pending BUY orders hold back (amount + fee at their reserve price and ref_fx). */
export function reservedCash(participantId: number): number {
  const { league } = load(participantId);
  const pending = sql("SELECT * FROM orders WHERE participant_id = ? AND status = 'pending' AND side = 'BUY'").all(
    participantId,
  ) as OrderRow[];
  const total = pending.reduce(
    (sum, o) =>
      sum +
      tradeCost(league.currency, 'BUY', o.quantity, reservePrice(o), ratesFor(league, o.symbol).fee_rate, 0, o.ref_fx ?? 1)
        .cash,
    0,
  );
  return roundMoney(league.currency, total);
}

/** Cash minus reservations for pending BUY orders. */
export function availableCash(participantId: number): number {
  const { participant, league } = load(participantId);
  return roundMoney(league.currency, participant.cash - reservedCash(participantId));
}

/** Orders that count toward the daily limit: every non-rejected order placed on `tradeDate`. */
export function ordersOnDate(participantId: number, tradeDate: string): number {
  return sql(
    "SELECT COUNT(*) FROM orders WHERE participant_id = ? AND trade_date = ? AND status <> 'rejected'",
  )
    .pluck()
    .get(participantId, tradeDate) as number;
}

/**
 * Holdings, cash and valuation. A finished league reports its final snapshot (the frozen
 * result standings use) and prices holdings as of that snapshot instead of live quotes (and
 * US holdings of ALL leagues at the USD/KRW the snapshot recorded, else — snapshots older than
 * snapshots.fx_rate — the rate stored at or before it). Values and P&L are in the league
 * currency; P&L includes the FX effect (cost basis qty × avg_price × avg_fx).
 */
export function getPortfolio(participantId: number): Portfolio {
  const { participant, league } = load(participantId);
  const final = league.status === 'finished' ? lastSnapshot(participantId) : undefined;
  const mid = (final && (final.fx_rate ?? fxAt(final.ts))) ?? getFx()?.rate;
  const holdings: Holding[] = getHoldings(participantId).map((h) => {
    const price = (final && storedPriceAt(h.symbol, final.ts)) ?? markPrice(h.symbol, h.avg_price);
    const fxRate = markFx(league, h, mid);
    const value = roundMoney(league.currency, h.quantity * price * fxRate);
    const cost = h.quantity * h.avg_price * (convertsFx(league.market, h.symbol) ? h.avg_fx : 1);
    return {
      symbol: h.symbol,
      name: getSymbol(h.symbol)?.name ?? h.symbol,
      currency: getSymbol(h.symbol)?.market === 'US' ? 'USD' : 'KRW',
      quantity: h.quantity,
      avg_price: h.avg_price,
      price,
      fx_rate: fxRate,
      value,
      pnl: roundMoney(league.currency, value - cost),
      pnl_rate: cost > 0 ? value / cost - 1 : 0,
    };
  });
  const equity = final?.equity ?? equityOf(participantId);
  return {
    participant_id: participant.id,
    league_id: league.id,
    currency: league.currency,
    cash: participant.cash,
    available_cash: availableCash(participantId),
    equity,
    return_rate: final?.return_rate ?? equity / league.start_cash - 1,
    holdings,
    orders_today: ordersOnDate(participantId, leagueTradeDate(league.market, now())),
    max_orders_per_day: league.max_orders_per_day,
    fx: league.market === 'ALL' ? getFx() : null,
  };
}
