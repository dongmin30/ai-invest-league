import type { Market, Quote } from '../../../shared/api-types';
import { now } from '../lib/time';
import { isMarketOpen, marketDate, quoteDelayMs, sessionBounds } from './calendar';

/** A quote older than this (beyond the source's normal delay) while its market is open is reported as stale. */
export const STALE_MS = 5 * 60_000;

const cache = new Map<string, Quote>();

export function getQuote(symbol: string): Quote | undefined {
  return cache.get(symbol);
}

export function getQuotes(market?: Market): Quote[] {
  const all = [...cache.values()];
  return market ? all.filter((q) => q.market === market) : all;
}

/** Caches each quote unless the symbol already has a newer one (an older fetch never wins). */
export function setQuotes(quotes: Quote[]): void {
  for (const q of quotes) {
    const prev = cache.get(q.symbol);
    if (!prev || q.ts >= prev.ts) cache.set(q.symbol, q);
  }
}

export function clearQuotes(): void {
  cache.clear();
}

export function isStale(q: Quote, at: number = now()): boolean {
  if (!isMarketOpen(q.market, at)) return false;
  // Before the session's first print arrives the latest quote is simply yesterday's close.
  const { open } = sessionBounds(q.market, marketDate(q.market, at));
  return at - Math.max(q.ts, open) > STALE_MS + quoteDelayMs(q.market);
}
