import type { LeagueMarket, Market } from '../../../shared/api-types';
import { config } from '../config';
import { now } from '../lib/time';
import { isHoliday } from './holidays';

// Regular sessions in market-local wall time. The close minute is inclusive:
// 15:30:00.000 KST is still open, 15:30:00.001 is closed. Times are converted with
// Intl.DateTimeFormat, so US daylight saving time is handled automatically.
//
// With config.simAlwaysOpen every calendar day is a trading day whose session spans the
// whole local day, and nextOpen() returns `at` itself so demo leagues start immediately.

interface Session {
  timeZone: string;
  open: [hour: number, minute: number];
  close: [hour: number, minute: number];
}

const SESSIONS: Record<Market, Session> = {
  KR: { timeZone: 'Asia/Seoul', open: [9, 0], close: [15, 30] },
  US: { timeZone: 'America/New_York', open: [9, 30], close: [16, 0] },
};

const DAY_MS = 86_400_000;
const MAX_SCAN_DAYS = 30;
/** Markets are still polled this long after the close: closing prints are stamped just after it. */
export const POST_CLOSE_FETCH_MS = 10 * 60_000;

export function marketTimeZone(market: Market): string {
  return SESSIONS[market].timeZone;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function localParts(timeZone: string, at: number): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(at)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour!,
    minute: out.minute!,
    second: out.second!,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

function toDateString(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Invalid date '${date}', expected YYYY-MM-DD`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return toDateString(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Epoch ms of a wall-clock time on `date` in `timeZone`. */
function zonedTime(timeZone: string, date: string, hour: number, minute: number): number {
  const [y, m, d] = parseDate(date);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const offsetAt = (t: number) => {
    const p = localParts(timeZone, t);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  // Second pass corrects the offset when `wall` and the result straddle a DST change.
  return wall - offsetAt(wall - offsetAt(wall));
}

/** Market-local calendar date (YYYY-MM-DD) of `at`. */
export function marketDate(market: Market, at: number = now()): string {
  const p = localParts(SESSIONS[market].timeZone, at);
  return toDateString(p.year, p.month, p.day);
}

export function isTradingDay(market: Market, date: string): boolean {
  if (config.simAlwaysOpen) return true;
  const [y, m, d] = parseDate(date);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !isHoliday(market, date);
}

/** Open and close epoch ms of the session on `date` (whether or not it is a trading day). */
export function sessionBounds(market: Market, date: string): { open: number; close: number } {
  const s = SESSIONS[market];
  if (config.simAlwaysOpen) {
    return { open: zonedTime(s.timeZone, date, 0, 0), close: zonedTime(s.timeZone, shiftDate(date, 1), 0, 0) - 1 };
  }
  return {
    open: zonedTime(s.timeZone, date, s.open[0], s.open[1]),
    close: zonedTime(s.timeZone, date, s.close[0], s.close[1]),
  };
}

export function isMarketOpen(market: Market, at: number = now()): boolean {
  if (config.simAlwaysOpen) return true;
  const date = marketDate(market, at);
  if (!isTradingDay(market, date)) return false;
  const { open, close } = sessionBounds(market, date);
  return at >= open && at <= close;
}

/**
 * Close of the session whose closing print `at` may be: a trading day's close when `at` falls
 * in (close, close + POST_CLOSE_FETCH_MS], else null. Providers stamp the closing auction
 * print a few seconds after the close (e.g. Yahoo KR 15:30:05 KST).
 */
export function closingPrintSession(market: Market, at: number): number | null {
  if (config.simAlwaysOpen) return null;
  const date = marketDate(market, at);
  if (!isTradingDay(market, date)) return null;
  const { close } = sessionBounds(market, date);
  return at > close && at <= close + POST_CLOSE_FETCH_MS ? close : null;
}

/** First trading date on or after `date`. */
function tradingDayOnOrAfter(market: Market, date: string): string {
  let d = date;
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    if (isTradingDay(market, d)) return d;
    d = shiftDate(d, 1);
  }
  throw new Error(`No ${market} trading day within ${MAX_SCAN_DAYS} days of ${date}`);
}

/** Start of the next session strictly after `at` (or `at` itself in simAlwaysOpen mode). */
export function nextOpen(market: Market, at: number = now()): number {
  if (config.simAlwaysOpen) return at;
  let date = tradingDayOnOrAfter(market, marketDate(market, at));
  let { open } = sessionBounds(market, date);
  if (open <= at) {
    date = tradingDayOnOrAfter(market, shiftDate(date, 1));
    open = sessionBounds(market, date).open;
  }
  return open;
}

/** End of the current session, or of the next one when the market is closed. */
export function nextClose(market: Market, at: number = now()): number {
  let date = tradingDayOnOrAfter(market, marketDate(market, at));
  let { close } = sessionBounds(market, date);
  if (close < at) {
    date = tradingDayOnOrAfter(market, shiftDate(date, 1));
    close = sessionBounds(market, date).close;
  }
  return close;
}

/**
 * Close time of the `days`-th trading day, counting the trading day of `startOpenAt` as
 * day 1 (or the next trading day when `startOpenAt` falls on a closed day).
 */
export function addTradingDays(market: Market, startOpenAt: number, days: number): number {
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`days must be a positive integer, got ${days}`);
  let date = tradingDayOnOrAfter(market, marketDate(market, startOpenAt));
  for (let i = 1; i < days; i++) date = tradingDayOnOrAfter(market, shiftDate(date, 1));
  return sessionBounds(market, date).close;
}

// ---- league calendars (KR, US or ALL) ----
//
// A 통합 (ALL) league trades both markets from one account. Their sessions never overlap
// (KR 09:00–15:30 KST, US 22:30–05:00 KST in EDT / 23:30–06:00 in EST), so a "unified day"
// runs from 08:00 KST to 08:00 KST the next day: KR date d holds the KR session of d and the US
// session of US date d (which ends the next morning KST). A unified day trades when either
// market does. With config.simAlwaysOpen an ALL league follows the KR calendar.

/** The unified day starts at 08:00 KST, after the latest US close (06:00 KST in EST). */
export const UNIFIED_DAY_START_HOUR_KST = 8;
const UNIFIED_DAY_OFFSET_MS = UNIFIED_DAY_START_HOUR_KST * 3_600_000;
const MARKETS: Market[] = ['KR', 'US'];

/** Whether the league can trade now: its market is open (ALL: either market). */
export function isLeagueOpen(market: LeagueMarket, at: number = now()): boolean {
  if (market !== 'ALL') return isMarketOpen(market, at);
  return MARKETS.some((m) => isMarketOpen(m, at));
}

/**
 * Trading date the daily order limit counts by; ALL: KR date of `at` − 8 h (day boundary 08:00
 * KST), or the KR date with config.simAlwaysOpen (its unified days follow the KR calendar).
 */
export function leagueTradeDate(market: LeagueMarket, at: number = now()): string {
  if (market !== 'ALL') return marketDate(market, at);
  if (config.simAlwaysOpen) return marketDate('KR', at);
  return marketDate('KR', at - UNIFIED_DAY_OFFSET_MS);
}

/** A unified day trades when the KR or the US market trades on that date. */
export function isUnifiedTradingDay(date: string): boolean {
  return isTradingDay('KR', date) || isTradingDay('US', date);
}

/**
 * Bounds of unified day `date`: opens at the KR open when KR trades that day (else the US open)
 * and closes at the US close when the US trades (else the KR close).
 */
export function unifiedSessionBounds(date: string): { open: number; close: number } {
  if (config.simAlwaysOpen) return sessionBounds('KR', date);
  const kr = sessionBounds('KR', date);
  const us = sessionBounds('US', date);
  return {
    open: isTradingDay('KR', date) ? kr.open : us.open,
    close: isTradingDay('US', date) ? us.close : kr.close,
  };
}

export function isLeagueTradingDay(market: LeagueMarket, date: string): boolean {
  return market === 'ALL' ? isUnifiedTradingDay(date) : isTradingDay(market, date);
}

export function leagueSessionBounds(market: LeagueMarket, date: string): { open: number; close: number } {
  return market === 'ALL' ? unifiedSessionBounds(date) : sessionBounds(market, date);
}

/** Earliest next open of the league's market(s) strictly after `at` (`at` itself with simAlwaysOpen). */
export function nextLeagueOpen(market: LeagueMarket, at: number = now()): number {
  if (market !== 'ALL') return nextOpen(market, at);
  return Math.min(nextOpen('KR', at), nextOpen('US', at));
}

/**
 * addTradingDays for any league market. ALL: close of the last session of the `days`-th
 * unified trading day, counting the unified day of `startOpenAt` as day 1 (the next one when
 * it does not trade or has already closed) — usually the US close, the next morning KST.
 */
export function addLeagueTradingDays(market: LeagueMarket, startOpenAt: number, days: number): number {
  if (market !== 'ALL') return addTradingDays(market, startOpenAt, days);
  if (config.simAlwaysOpen) return addTradingDays('KR', startOpenAt, days);
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`days must be a positive integer, got ${days}`);
  const unifiedDayOnOrAfter = (d: string): string => {
    for (let i = 0; i <= MAX_SCAN_DAYS; i++, d = shiftDate(d, 1)) if (isUnifiedTradingDay(d)) return d;
    throw new Error(`No unified trading day within ${MAX_SCAN_DAYS} days of ${d}`);
  };
  let date = unifiedDayOnOrAfter(leagueTradeDate('ALL', startOpenAt));
  if (unifiedSessionBounds(date).close < startOpenAt) date = unifiedDayOnOrAfter(shiftDate(date, 1));
  for (let i = 1; i < days; i++) date = unifiedDayOnOrAfter(shiftDate(date, 1));
  return unifiedSessionBounds(date).close;
}

/**
 * The market whose session close is the league's end_at: the league market itself, and for ALL
 * the US when end_at is a US close, else KR (a US holiday on the last day, or simAlwaysOpen).
 */
export function closingMarketOf(league: { market: LeagueMarket; end_at: number }): Market {
  if (league.market !== 'ALL') return league.market;
  if (config.simAlwaysOpen) return 'KR';
  const usDate = marketDate('US', league.end_at);
  return isTradingDay('US', usDate) && sessionBounds('US', usDate).close === league.end_at ? 'US' : 'KR';
}
