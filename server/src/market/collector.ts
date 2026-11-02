import type { Market, Quote } from '../../../shared/api-types';
import { db, tx } from '../db/db';
import { bus } from '../lib/bus';
import { now } from '../lib/time';
import { closingPrintSession, isMarketOpen, POST_CLOSE_FETCH_MS } from './calendar';
import { getFx, setFx, storeFx } from './fx';
import type { DailyBar, PriceProvider } from './providers/types';
import { errorMessage } from './providers/http';
import { getQuote, setQuotes } from './quoteCache';
import { SYMBOLS, type SymbolInfo } from './symbols';

/** Number of daily bars kept per symbol (about one month of sessions). */
export const DAILY_BARS_DAYS = 22;

const MINUTE_MS = 60_000;
const MARKETS: Market[] = ['KR', 'US'];
export { POST_CLOSE_FETCH_MS };

export interface Collector {
  /**
   * Fetches quotes for open markets, markets that closed less than POST_CLOSE_FETCH_MS ago,
   * and any symbol without a cached quote; stores and broadcasts them. USD/KRW is fetched once
   * per tick (separate call) while either market is in that window or until this collector has
   * fetched one (a rate seeded from fx_rates at boot does not count); it is stored, cached and
   * broadcast as bus 'fx'. Returns the quotes.
   */
  tick(): Promise<Quote[]>;
  /**
   * Refreshes `daily_bars` for every symbol: one batched provider call when supported, then
   * per-symbol requests for the rest. Per-symbol failures are logged and skipped.
   */
  loadDailyBars(): Promise<void>;
}

/** One `quotes` row per symbol per minute: ts is floored to the minute and later quotes replace earlier ones. */
export function storeQuotes(quotes: Quote[]): void {
  if (quotes.length === 0) return;
  const insert = db.prepare('INSERT OR REPLACE INTO quotes (symbol, ts, price, volume, source) VALUES (?, ?, ?, ?, ?)');
  tx(() => {
    for (const q of quotes) {
      insert.run(q.symbol, Math.floor(q.ts / MINUTE_MS) * MINUTE_MS, q.price, q.volume, q.source);
    }
  });
}

/** Last `n` daily closes of `symbol`, oldest first. */
export function getDailyCloses(symbol: string, n: number): number[] {
  if (n <= 0) return [];
  const rows = db
    .prepare('SELECT close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?')
    .pluck()
    .all(symbol, n) as number[];
  return rows.reverse();
}

export function createCollector(provider: PriceProvider): Collector {
  const openMarkets = (at: number) =>
    new Set(MARKETS.filter((m) => isMarketOpen(m, at) || closingPrintSession(m, at) !== null));

  function symbolsToFetch(open: Set<Market>): SymbolInfo[] {
    // Symbols with no cached quote are fetched even while closed, so prices exist right after boot.
    return SYMBOLS.filter((s) => open.has(s.market) || !getQuote(s.symbol));
  }

  let fxFetched = false;

  async function collectFx(): Promise<void> {
    try {
      const fx = await provider.fetchFx!();
      if (!(Number.isFinite(fx.rate) && fx.rate > 0)) return;
      storeFx(fx);
      setFx(fx);
      fxFetched = true;
      bus.emit('fx', getFx()!);
    } catch (err) {
      console.warn(`[collector] USD/KRW failed: ${errorMessage(err)}`);
    }
  }

  async function collectQuotes(symbols: SymbolInfo[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    const wanted = new Set(symbols.map((s) => s.symbol));
    const quotes = (await provider.fetchQuotes(symbols)).filter(
      (q) => wanted.has(q.symbol) && Number.isFinite(q.price) && q.price > 0,
    );
    if (quotes.length === 0) return [];

    storeQuotes(quotes);
    setQuotes(quotes);
    bus.emit('quotes', quotes);
    return quotes;
  }

  return {
    async tick() {
      const open = openMarkets(now());
      // Both settle before tick() resolves, so the matcher sees this tick's rate.
      const fx = provider.fetchFx && (open.size > 0 || !fxFetched) ? collectFx() : Promise.resolve();
      try {
        return await collectQuotes(symbolsToFetch(open));
      } finally {
        await fx;
      }
    },

    async loadDailyBars() {
      const upsert = db.prepare(
        'INSERT OR REPLACE INTO daily_bars (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      // Batched first (Yahoo spark: ~20 symbols per request), then one by one for whatever the batch missed.
      let batched = new Map<string, DailyBar[]>();
      if (provider.fetchDailyBarsMany) {
        try {
          batched = await provider.fetchDailyBarsMany(SYMBOLS, DAILY_BARS_DAYS);
        } catch (err) {
          console.warn(`[collector] batched daily bars failed: ${errorMessage(err)}`);
        }
      }
      const rest = SYMBOLS.filter((s) => !batched.has(s.symbol));
      const results = await Promise.allSettled(
        rest.map(async (info) => ({ info, bars: await provider.fetchDailyBars(info, DAILY_BARS_DAYS) })),
      );

      let failed = 0;
      tx(() => {
        for (const [symbol, bars] of batched) {
          for (const b of bars) upsert.run(symbol, b.date, b.open, b.high, b.low, b.close, b.volume);
        }
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            failed++;
            console.warn(`[collector] daily bars ${rest[i]!.symbol} failed: ${errorMessage(r.reason)}`);
            return;
          }
          for (const b of r.value.bars) {
            upsert.run(r.value.info.symbol, b.date, b.open, b.high, b.low, b.close, b.volume);
          }
        });
      });
      if (failed > 0) console.warn(`[collector] daily bars: ${failed}/${SYMBOLS.length} symbols failed`);
    },
  };
}
