import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quote } from '../../../shared/api-types';
import { config } from '../../src/config';
import { db, resetDb } from '../../src/db/db';
import { bus } from '../../src/lib/bus';
import { setNow } from '../../src/lib/time';
import { createCollector, DAILY_BARS_DAYS, getDailyCloses, POST_CLOSE_FETCH_MS } from '../../src/market/collector';
import type { DailyBar, PriceProvider } from '../../src/market/providers/types';
import { clearQuotes, getQuote, getQuotes } from '../../src/market/quoteCache';
import { createYahooProvider, SPARK_MAX_SYMBOLS } from '../../src/market/providers/yahoo';
import { SYMBOLS, symbolsFor, type SymbolInfo } from '../../src/market/symbols';
import { fixture, jsonResponse } from './fixtures';

const KR_OPEN = Date.UTC(2026, 9, 19, 1, 0, 30); // Mon 10:00:30 KST; New York is Sunday night
const SATURDAY = Date.UTC(2026, 9, 17, 3, 0);
const KR_CLOSE = Date.UTC(2026, 9, 19, 6, 30); // Mon 15:30 KST
const MINUTE = 60_000;

let clock = KR_OPEN;

/** Provider whose prices are `base + call number`, with the source timestamp = now. */
function fakeProvider(opts: { failBars?: string[] } = {}) {
  let call = 0;
  const requested: string[][] = [];
  const provider: PriceProvider = {
    name: 'sim',
    fetchQuotes: vi.fn(async (symbols: SymbolInfo[]) => {
      call++;
      requested.push(symbols.map((s) => s.symbol));
      return symbols.map(
        (s): Quote => ({
          symbol: s.symbol,
          market: s.market,
          price: 100 + call,
          change_pct: 1,
          volume: 1000 * call,
          ts: clock,
          source: 'sim',
        }),
      );
    }),
    fetchDailyBars: vi.fn(async (s: SymbolInfo, days: number): Promise<DailyBar[]> => {
      if (opts.failBars?.includes(s.symbol)) throw new Error('down');
      return Array.from({ length: days }, (_, i) => ({
        date: `2026-09-${String(i + 1).padStart(2, '0')}`,
        open: null,
        high: null,
        low: null,
        close: i + 1,
        volume: null,
      }));
    }),
  };
  return { provider, requested };
}

const rowsFor = (symbol: string) =>
  db.prepare('SELECT ts, price, volume, source FROM quotes WHERE symbol = ? ORDER BY ts').all(symbol) as {
    ts: number;
    price: number;
    volume: number;
    source: string;
  }[];

beforeEach(() => {
  resetDb();
  clearQuotes();
  clock = KR_OPEN;
  setNow(() => clock);
  config.simAlwaysOpen = false;
});

afterEach(() => {
  setNow(null);
  config.simAlwaysOpen = false;
  vi.restoreAllMocks();
});

describe('collector.tick', () => {
  it('fetches every symbol on the first tick, then only open markets', async () => {
    const { provider, requested } = fakeProvider();
    const collector = createCollector(provider);

    expect(await collector.tick()).toHaveLength(SYMBOLS.length);
    expect(getQuotes()).toHaveLength(SYMBOLS.length);

    clock += MINUTE;
    const second = await collector.tick();
    expect(requested[1]).toEqual(symbolsFor('KR').map((s) => s.symbol));
    expect(second.every((q) => q.market === 'KR')).toBe(true);
  });

  it('keeps polling a market for a few minutes after its close to catch the closing print', async () => {
    const { provider, requested } = fakeProvider();
    const collector = createCollector(provider);
    await collector.tick();

    clock = KR_CLOSE + 5 * MINUTE;
    await collector.tick();
    expect(requested[1]).toEqual(symbolsFor('KR').map((s) => s.symbol));

    clock = KR_CLOSE + POST_CLOSE_FETCH_MS + MINUTE;
    expect(await collector.tick()).toEqual([]);
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(2);
  });

  it('skips the provider when both markets are closed and every symbol has a quote', async () => {
    const { provider } = fakeProvider();
    const collector = createCollector(provider);
    clock = SATURDAY;
    await collector.tick();
    expect(await collector.tick()).toEqual([]);
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it('fetches both markets when SIM_ALWAYS_OPEN is set', async () => {
    const { provider, requested } = fakeProvider();
    const collector = createCollector(provider);
    clock = SATURDAY;
    config.simAlwaysOpen = true;
    await collector.tick();
    await collector.tick();
    expect(requested[1]).toHaveLength(SYMBOLS.length);
  });

  it('keeps one quotes row per symbol per minute (latest wins, ts floored)', async () => {
    const { provider } = fakeProvider();
    const collector = createCollector(provider);
    await collector.tick();
    clock += 20_000; // 10:00:50, same minute
    await collector.tick();
    clock += 30_000; // 10:01:20
    await collector.tick();

    const minute = Math.floor(KR_OPEN / MINUTE) * MINUTE;
    expect(rowsFor('005930')).toEqual([
      { ts: minute, price: 102, volume: 2000, source: 'sim' },
      { ts: minute + MINUTE, price: 103, volume: 3000, source: 'sim' },
    ]);
    // The cache keeps the unfloored source timestamp.
    expect(getQuote('005930')!.ts).toBe(clock);
  });

  it('emits bus quotes with what it stored', async () => {
    const { provider } = fakeProvider();
    const listener = vi.fn();
    bus.on('quotes', listener);
    try {
      const quotes = await createCollector(provider).tick();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(quotes);
    } finally {
      bus.off('quotes', listener);
    }
  });

  it('ignores quotes with invalid prices and does not emit when nothing is left', async () => {
    const provider: PriceProvider = {
      name: 'sim',
      fetchQuotes: async (symbols) =>
        symbols.map((s) => ({ symbol: s.symbol, market: s.market, price: 0, change_pct: 0, volume: 0, ts: clock, source: 'sim' })),
      fetchDailyBars: async () => [],
    };
    const listener = vi.fn();
    bus.on('quotes', listener);
    try {
      expect(await createCollector(provider).tick()).toEqual([]);
      expect(listener).not.toHaveBeenCalled();
      expect(getQuotes()).toEqual([]);
    } finally {
      bus.off('quotes', listener);
    }
  });
});

describe('collector.loadDailyBars / getDailyCloses', () => {
  it('stores bars for every symbol and skips failing ones', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { provider } = fakeProvider({ failBars: ['AAPL'] });
    await createCollector(provider).loadDailyBars();

    expect(provider.fetchDailyBars).toHaveBeenCalledTimes(SYMBOLS.length);
    // The fake provider's closes are 1..DAILY_BARS_DAYS in date order.
    expect(getDailyCloses('005930', 3)).toEqual([DAILY_BARS_DAYS - 2, DAILY_BARS_DAYS - 1, DAILY_BARS_DAYS]);
    expect(getDailyCloses('005930', 100)).toHaveLength(DAILY_BARS_DAYS);
    expect(getDailyCloses('AAPL', 5)).toEqual([]);
    expect(getDailyCloses('005930', 0)).toEqual([]);
  });

  it('replaces bars for the same date on reload', async () => {
    const { provider } = fakeProvider();
    const collector = createCollector(provider);
    await collector.loadDailyBars();
    await collector.loadDailyBars();
    const count = db.prepare("SELECT COUNT(*) FROM daily_bars WHERE symbol = '005930'").pluck().get();
    expect(count).toBe(DAILY_BARS_DAYS);
  });
});

describe('collector with the batched Yahoo provider (mocked fetch)', () => {
  /** Spark answers for every requested ticker except those in `omit`, reusing a real 1d or 3mo entry. */
  function yahooFetch(opts: { omit?: string[]; failSpark?: boolean } = {}) {
    return vi.fn(async (url: string) => {
      if (url.includes('/v7/finance/spark')) {
        if (opts.failSpark) return jsonResponse({}, 400);
        const params = new URL(url).searchParams;
        const daily = params.get('range') !== '1d';
        const template = fixture(daily ? 'yahoo-spark-3mo-1d.json' : 'yahoo-spark-1d-1d.json').spark.result[0];
        const result = decodeURIComponent(params.get('symbols')!)
          .split(',')
          .filter((t) => !opts.omit?.includes(t))
          .map((t) => ({ ...JSON.parse(JSON.stringify(template)), symbol: t }));
        return jsonResponse({ spark: { result, error: null } });
      }
      const daily = url.includes('interval=1d');
      return jsonResponse(fixture(daily ? 'yahoo-chart-1d-005930.KS.json' : 'yahoo-chart-1m-AAPL.json'));
    });
  }
  const sparkCalls = (f: ReturnType<typeof yahooFetch>) => f.mock.calls.filter(([u]) => String(u).includes('/spark')).length;
  const isFx = (u: unknown) => String(u).includes('/chart/KRW%3DX');
  const chartCalls = (f: ReturnType<typeof yahooFetch>) =>
    f.mock.calls.filter(([u]) => String(u).includes('/chart/') && !isFx(u)).length;
  const fxCalls = (f: ReturnType<typeof yahooFetch>) => f.mock.calls.filter(([u]) => isFx(u)).length;

  it('refreshes the whole universe with ceil(n / 20) spark calls on the first tick', async () => {
    const fetchImpl = yahooFetch();
    const quotes = await createCollector(createYahooProvider({ fetchImpl })).tick();
    expect(quotes).toHaveLength(SYMBOLS.length);
    expect(sparkCalls(fetchImpl)).toBe(Math.ceil(SYMBOLS.length / SPARK_MAX_SYMBOLS));
    expect(chartCalls(fetchImpl)).toBe(0);
    // USD/KRW is its own chart call (no rate cached yet), never part of a spark chunk.
    expect(fxCalls(fetchImpl)).toBe(1);
  });

  it('falls back to per-symbol chart requests for tickers a spark batch misses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = yahooFetch({ omit: ['005930.KS', 'AAPL'] });
    const quotes = await createCollector(createYahooProvider({ fetchImpl })).tick();
    expect(quotes).toHaveLength(SYMBOLS.length);
    expect(chartCalls(fetchImpl)).toBe(2);
  });

  it('loads daily bars through spark batches and per-symbol charts for the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = yahooFetch({ omit: ['005930.KS'] });
    await createCollector(createYahooProvider({ fetchImpl })).loadDailyBars();
    expect(sparkCalls(fetchImpl)).toBe(Math.ceil(SYMBOLS.length / SPARK_MAX_SYMBOLS));
    expect(chartCalls(fetchImpl)).toBe(1);
    expect(fetchImpl.mock.calls.find(([u]) => String(u).includes('/chart/'))![0]).toContain('/005930.KS?interval=1d&range=3mo');
    // Spark bars: closes only; the chart fallback keeps full OHLCV.
    const spark = db.prepare("SELECT open, close, volume FROM daily_bars WHERE symbol = 'SPY' ORDER BY date DESC LIMIT 1").get();
    expect(spark).toEqual({ open: null, close: 755.72, volume: null });
    expect(getDailyCloses('SPY', 100)).toHaveLength(DAILY_BARS_DAYS);
    const chart = db.prepare("SELECT open, close FROM daily_bars WHERE symbol = '005930' ORDER BY date DESC LIMIT 1").get() as {
      open: number | null;
      close: number;
    };
    expect(chart.close).toBe(215500);
    expect(chart.open).not.toBeNull();
  });

  it('loads every daily bar per symbol when spark is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = yahooFetch({ failSpark: true });
    await createCollector(createYahooProvider({ fetchImpl, retryDelayMs: 1 })).loadDailyBars();
    expect(chartCalls(fetchImpl)).toBe(SYMBOLS.length);
    expect(getDailyCloses('AAPL', 1)).toEqual([215500]);
  });
});
