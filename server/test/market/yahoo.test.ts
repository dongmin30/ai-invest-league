import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createYahooProvider,
  parseYahooDailyBars,
  parseYahooQuote,
  parseYahooSpark,
  rangeForDays,
  SPARK_MAX_SYMBOLS,
  YAHOO_COOLDOWN_MS,
  YahooError,
} from '../../src/market/providers/yahoo';
import { getSymbol, SYMBOLS, symbolsFor, type SymbolInfo } from '../../src/market/symbols';
import { fixture, jsonResponse } from './fixtures';

const samsung = getSymbol('005930')!;
const apple = getSymbol('AAPL')!;
const msft = getSymbol('MSFT')!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseYahooQuote (real responses, 2026-10-16)', () => {
  it('parses a KOSPI 1m chart', () => {
    expect(parseYahooQuote(fixture('yahoo-chart-1m-005930.KS.json'), samsung)).toEqual({
      symbol: '005930',
      market: 'KR',
      price: 215500,
      change_pct: 2.62,
      volume: 20296806,
      ts: 1792132205000,
      source: 'yahoo',
    });
  });

  it('parses a NASDAQ 1m chart', () => {
    const q = parseYahooQuote(fixture('yahoo-chart-1m-AAPL.json'), apple);
    expect(q).toMatchObject({ symbol: 'AAPL', market: 'US', price: 343.46, volume: 59852690, source: 'yahoo' });
    expect(q.change_pct).toBe(0.43); // 343.46 vs previous close 342
    expect(q.ts).toBe(1792180801000);
  });

  it('falls back to the last non-null close and its timestamp', () => {
    const json = fixture('yahoo-chart-1m-AAPL.json');
    const r = json.chart.result[0];
    delete r.meta.regularMarketPrice;
    delete r.meta.regularMarketTime;
    r.indicators.quote[0].close[4] = null;
    const q = parseYahooQuote(json, apple);
    expect(q.price).toBe(r.indicators.quote[0].close[3]);
    expect(q.ts).toBe(r.timestamp[3] * 1000);
  });

  it('uses regularMarketChangePercent when no previous close is present', () => {
    const json = fixture('yahoo-chart-1m-005930.KS.json');
    const meta = json.chart.result[0].meta;
    delete meta.previousClose;
    delete meta.chartPreviousClose;
    delete meta.regularMarketVolume;
    const q = parseYahooQuote(json, samsung);
    expect(q.change_pct).toBe(2.62);
    expect(q.volume).toBe(0);
  });

  it('throws when the response has no usable price', () => {
    const json = fixture('yahoo-chart-1m-AAPL.json');
    const r = json.chart.result[0];
    delete r.meta.regularMarketPrice;
    r.indicators.quote[0].close = [null, null];
    expect(() => parseYahooQuote(json, apple)).toThrow(YahooError);
    expect(() => parseYahooQuote({}, apple)).toThrow(YahooError);
  });

  it('surfaces chart.error for unknown symbols', () => {
    expect(() => parseYahooQuote(fixture('yahoo-chart-not-found.json'), apple)).toThrow(/symbol may be delisted/);
  });
});

describe('parseYahooDailyBars', () => {
  it('parses one month of KOSPI daily bars with market-local dates', () => {
    const bars = parseYahooDailyBars(fixture('yahoo-chart-1d-005930.KS.json'));
    expect(bars).toHaveLength(19);
    expect(bars[0]).toMatchObject({ date: '2026-09-16', close: 253500 });
    expect(bars.at(-1)).toEqual({
      date: '2026-10-16',
      open: expect.any(Number),
      high: 222500,
      low: 210500,
      close: 215500,
      volume: expect.any(Number),
    });
    const dates = bars.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
    expect(dates).not.toContain('2026-10-09'); // 한글날
  });

  it('skips rows without a close and keeps missing OHLC as null', () => {
    const json = fixture('yahoo-chart-1d-005930.KS.json');
    const q = json.chart.result[0].indicators.quote[0];
    q.close[1] = null;
    q.open[2] = null;
    const bars = parseYahooDailyBars(json);
    expect(bars).toHaveLength(18);
    expect(bars[1]!.open).toBeNull();
  });
});

describe('rangeForDays', () => {
  it('picks the smallest covering range', () => {
    expect(rangeForDays(3)).toBe('5d');
    expect(rangeForDays(18)).toBe('1mo');
    expect(rangeForDays(22)).toBe('3mo');
    expect(rangeForDays(200)).toBe('1y');
  });
});

describe('createYahooProvider', () => {
  const chartFor = (info: SymbolInfo) => {
    const json = fixture('yahoo-chart-1m-AAPL.json');
    json.chart.result[0].meta.symbol = info.yahoo;
    return json;
  };

  it('sends a browser User-Agent and retries once on 429', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1 ? jsonResponse({}, 429) : jsonResponse(chartFor(apple));
    });
    const quotes = await createYahooProvider({ fetchImpl, retryDelayMs: 1, batch: false }).fetchQuotes([apple]);
    expect(quotes).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[0]!.url).toBe('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1m&range=1d');
    expect((calls[0]!.init?.headers as Record<string, string>)['User-Agent']).toMatch(/^Mozilla\/5\.0/);
  });

  it('drops failing symbols without failing the batch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/MSFT?')) return jsonResponse({}, 503);
      if (url.includes('/005930.KS?')) return jsonResponse(fixture('yahoo-chart-not-found.json'), 404);
      return jsonResponse(chartFor(apple));
    });
    const quotes = await createYahooProvider({ fetchImpl, retryDelayMs: 1, batch: false }).fetchQuotes([apple, msft, samsung]);
    expect(quotes.map((q) => q.symbol)).toEqual(['AAPL']);
    // MSFT: 503 + one retry; 005930: 404 is not retried; AAPL: one call.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('retries once after a network error', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return jsonResponse(chartFor(apple));
    });
    const quotes = await createYahooProvider({ fetchImpl, retryDelayMs: 1, batch: false }).fetchQuotes([apple]);
    expect(quotes).toHaveLength(1);
  });

  it('runs at most 4 requests at once', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return jsonResponse(chartFor(apple));
    });
    const symbols = Array.from({ length: 12 }, () => apple);
    const quotes = await createYahooProvider({ fetchImpl, batch: false }).fetchQuotes(symbols);
    expect(quotes).toHaveLength(12);
    expect(peak).toBe(4);
  });

  it('fetches daily bars with a covering range and trims to the requested count', async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse(fixture('yahoo-chart-1d-005930.KS.json')));
    const bars = await createYahooProvider({ fetchImpl }).fetchDailyBars(samsung, 5);
    expect(fetchImpl.mock.calls[0]![0]).toContain('/005930.KS?interval=1d&range=1mo');
    expect(bars.map((b) => b.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  });
});

describe('spark batching (real responses, 2026-10-30)', () => {
  const spy = getSymbol('SPY')!;
  const tqqq = getSymbol('TQQQ')!;
  const kodexLev = getSymbol('122630')!;

  /** A spark body with one entry per requested ticker present in the 1d fixture (others are omitted, like Yahoo does). */
  function sparkFor(url: string) {
    const wanted = decodeURIComponent(new URL(url).searchParams.get('symbols')!).split(',');
    const json = fixture('yahoo-spark-1d-1d.json');
    const byTicker = new Map(json.spark.result.map((r: { symbol: string }) => [r.symbol, r]));
    const result = wanted.flatMap((t) => {
      const base = byTicker.get(t) ?? byTicker.get('SPY');
      if (t.startsWith('MISSING')) return [];
      const copy = JSON.parse(JSON.stringify(base));
      copy.symbol = t;
      return [copy];
    });
    return { spark: { result, error: null } };
  }

  it('parses spark entries into chart results keyed by ticker', () => {
    const results = parseYahooSpark(fixture('yahoo-spark-1d-1d.json'));
    expect([...results.keys()].sort()).toEqual(['005930.KS', '122630.KS', 'SPY', 'TQQQ']);
    expect(parseYahooSpark({})).toEqual(new Map());
    expect(parseYahooSpark({ spark: { result: [{ symbol: 'X', response: [] }] } })).toEqual(new Map());
  });

  it('fetches quotes for up to 20 symbols per spark call with the chart meta fields', async () => {
    const fetchImpl = vi.fn(async (url: string) => jsonResponse(sparkFor(url)));
    const quotes = await createYahooProvider({ fetchImpl }).fetchQuotes([spy, kodexLev, tqqq, samsung]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://query1.finance.yahoo.com/v7/finance/spark?symbols=SPY,122630.KS,TQQQ,005930.KS&range=1d&interval=1d',
    );
    expect(quotes.map((q) => q.symbol)).toEqual(['SPY', '122630', 'TQQQ', '005930']);
    expect(quotes[1]).toEqual({
      symbol: '122630',
      market: 'KR',
      price: 72545,
      change_pct: -7.64, // vs chartPreviousClose 78550
      volume: 23223639,
      ts: 1793341804000, // 15:30:04 KST: the closing print stays after the close
      source: 'yahoo',
    });
    expect(quotes[3]!.ts).toBe(1793341809000);
  });

  it('chunks a full market refresh into ceil(n / 20) calls with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return jsonResponse(sparkFor(url));
    });
    const us = symbolsFor('US');
    const quotes = await createYahooProvider({ fetchImpl }).fetchQuotes(us);
    expect(quotes).toHaveLength(us.length);
    expect(fetchImpl).toHaveBeenCalledTimes(Math.ceil(us.length / SPARK_MAX_SYMBOLS));
    for (const [url] of fetchImpl.mock.calls) {
      expect(decodeURIComponent(new URL(url).searchParams.get('symbols')!).split(',').length).toBeLessThanOrEqual(SPARK_MAX_SYMBOLS);
    }
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('falls back per symbol only for tickers a successful spark response lacks, never for a failed chunk', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing: SymbolInfo = { ...apple, symbol: 'MISSINGX', yahoo: 'MISSINGX' };
    const symbols = [...SYMBOLS.filter((s) => s.market === 'US' && s.symbol !== 'MSFT').slice(0, 20), missing, msft];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/v7/finance/spark')) {
        // First chunk (20 symbols) fails twice (503 + retry); the second chunk answers but omits MISSINGX.
        return url.includes('MISSINGX') ? jsonResponse(sparkFor(url)) : jsonResponse({}, 503);
      }
      const ticker = decodeURIComponent(url.split('/chart/')[1]!.split('?')[0]!);
      if (ticker === 'MISSINGX') return jsonResponse(fixture('yahoo-chart-not-found.json'), 404);
      const json = fixture('yahoo-chart-1m-AAPL.json');
      json.chart.result[0].meta.symbol = ticker;
      return jsonResponse(json);
    });
    const quotes = await createYahooProvider({ fetchImpl, retryDelayMs: 1 }).fetchQuotes(symbols);
    // The failed chunk's 20 symbols are skipped (they keep their cached quotes); MSFT via spark; MISSINGX dropped.
    expect(quotes.map((q) => q.symbol)).toEqual([msft.symbol]);
    const sparkCalls = fetchImpl.mock.calls.filter(([u]) => u.includes('/spark'));
    const chartCalls = fetchImpl.mock.calls.filter(([u]) => u.includes('/chart/'));
    expect(sparkCalls).toHaveLength(3);
    expect(chartCalls.map(([u]) => u)).toEqual(['https://query1.finance.yahoo.com/v8/finance/chart/MISSINGX?interval=1m&range=1d']);
  });

  it('pauses every Yahoo request for 60 s after a 429 that survives the retry, logging once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let t = 1_000_000;
    let limited = true;
    const fetchImpl = vi.fn(async (url: string) => (limited ? jsonResponse({}, 429) : jsonResponse(sparkFor(url))));
    const provider = createYahooProvider({ fetchImpl, retryDelayMs: 1, clock: () => t });
    const us = symbolsFor('US'); // 9 chunks

    expect(await provider.fetchQuotes(us)).toEqual([]);
    // Requests started before the first retry failed may still go out; everything after the
    // trip (queued chunks, retries, per-symbol fallbacks) is not sent: no chart calls at all
    // (without the breaker: 9 × 2 spark calls + 163 chart calls).
    expect(fetchImpl.mock.calls.every(([u]) => u.includes('/spark'))).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeLessThan(2 * Math.ceil(us.length / SPARK_MAX_SYMBOLS));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/429.*60s/);

    const sent = fetchImpl.mock.calls.length;
    limited = false;
    t += YAHOO_COOLDOWN_MS - 1;
    expect(await provider.fetchQuotes(us)).toEqual([]);
    expect(await provider.fetchDailyBarsMany!(us, 5)).toEqual(new Map());
    await expect(provider.fetchFx!()).rejects.toThrow(/paused after HTTP 429/);
    expect(fetchImpl).toHaveBeenCalledTimes(sent);
    expect(warn).toHaveBeenCalledTimes(1);

    t += 1;
    expect(await provider.fetchQuotes(us)).toHaveLength(us.length);
    expect(fetchImpl).toHaveBeenCalledTimes(sent + Math.ceil(us.length / SPARK_MAX_SYMBOLS));
  });

  it('does not fall back when fallback is off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => jsonResponse({}, 400));
    const quotes = await createYahooProvider({ fetchImpl, fallback: false }).fetchQuotes([spy, apple]);
    expect(quotes).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('loads close-only daily bars in batches, trimmed to the requested count', async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse(fixture('yahoo-spark-3mo-1d.json')));
    const bars = await createYahooProvider({ fetchImpl }).fetchDailyBarsMany!([spy, samsung, apple], 22);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toContain('symbols=SPY,005930.KS,AAPL&range=3mo&interval=1d');
    expect([...bars.keys()]).toEqual(['SPY', '005930']); // AAPL absent from the response
    const kr = bars.get('005930')!;
    expect(kr).toHaveLength(22);
    expect(kr.at(-1)).toEqual({ date: '2026-10-30', open: null, high: null, low: null, close: 225000, volume: null });
    expect(bars.get('SPY')!.at(-1)).toMatchObject({ date: '2026-10-30', close: 755.72 });
  });
});
