import type { Quote } from '../../../../shared/api-types';
import type { SymbolInfo } from '../symbols';
import { backoffMs, createLimiter, errorMessage, sleep } from './http';
import type { DailyBar, FetchLike, FxTick, PriceProvider } from './types';

// Yahoo Finance chart JSON (keyless, unofficial). Requests need a browser User-Agent,
// otherwise Yahoo answers 429. KRX prices may be delayed relative to the exchange.
//
// Quotes and daily bars are fetched in batches through the v7 spark endpoint (up to 20
// tickers per call; each entry carries the same `meta` as a chart response). Tickers a
// successful spark response lacks (unknown ticker, no price) fall back to the per-symbol v8
// chart endpoint; a chunk whose call fails as a whole is skipped (no per-symbol fallback, which
// would turn one 429 into 20 more requests). A 429 that survives the retry pauses every request
// of the provider for YAHOO_COOLDOWN_MS (logged once); the collector keeps its cached quotes.
// Spark daily bars carry closes only (open/high/low/volume are null).

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const SPARK_URL = 'https://query1.finance.yahoo.com/v7/finance/spark';
/** USD/KRW (KRW per 1 USD); fetched with its own chart call, never inside spark chunks. */
export const YAHOO_FX_TICKER = 'KRW=X';
/** Yahoo answers HTTP 400 for spark requests with more than 20 symbols. */
export const SPARK_MAX_SYMBOLS = 20;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAX_CONCURRENT = 4;
const REQUEST_TIMEOUT_MS = 10_000;
/** After a 429 that survives the retry, the provider sends no Yahoo request for this long. */
export const YAHOO_COOLDOWN_MS = 60_000;

export class YahooError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'YahooError';
  }
}

type Num = number | null | undefined;

interface ChartResult {
  meta?: {
    regularMarketPrice?: Num;
    regularMarketTime?: Num;
    regularMarketVolume?: Num;
    regularMarketChangePercent?: Num;
    previousClose?: Num;
    chartPreviousClose?: Num;
    gmtoffset?: Num;
  };
  timestamp?: Num[];
  indicators?: {
    quote?: { open?: Num[]; high?: Num[]; low?: Num[]; close?: Num[]; volume?: Num[] }[];
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
// Daily OHLC arrive as float32 noise (337.0000061...); 4 decimals is beyond any tick size.
const price4 = (v: unknown): number | null => (isNum(v) ? round(v, 4) : null);

function chartResult(json: unknown): ChartResult {
  const chart = (json as { chart?: { result?: ChartResult[] | null; error?: { description?: string } | null } })
    ?.chart;
  const result = chart?.result?.[0];
  if (!result) {
    throw new YahooError(chart?.error?.description ?? 'Yahoo chart response has no result');
  }
  return result;
}

function lastValue(values: Num[] | undefined): { value: number; index: number } | undefined {
  if (!values) return undefined;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (isNum(v)) return { value: v, index: i };
  }
  return undefined;
}

/**
 * Parses a v7 spark response into one chart result per Yahoo ticker. Unknown tickers are
 * simply absent from the response, so they are absent from the map.
 */
export function parseYahooSpark(json: unknown): Map<string, ChartResult> {
  const results = (json as { spark?: { result?: { symbol?: unknown; response?: ChartResult[] | null }[] | null } })
    ?.spark?.result;
  const out = new Map<string, ChartResult>();
  for (const r of results ?? []) {
    const result = r?.response?.[0];
    if (typeof r?.symbol === 'string' && result?.meta) out.set(r.symbol, result);
  }
  return out;
}

/** Parses a `interval=1m&range=1d` chart response into a Quote. Throws YahooError if it has no price. */
export function parseYahooQuote(json: unknown, info: SymbolInfo): Quote {
  return quoteFromResult(chartResult(json), info);
}

function quoteFromResult(result: ChartResult, info: SymbolInfo): Quote {
  const meta = result.meta ?? {};
  const closes = result.indicators?.quote?.[0]?.close;
  const lastClose = lastValue(closes);

  const price = isNum(meta.regularMarketPrice) && meta.regularMarketPrice > 0 ? meta.regularMarketPrice : lastClose?.value;
  if (!isNum(price) || price <= 0) throw new YahooError(`No price for ${info.yahoo}`);

  const lastTs = lastClose ? result.timestamp?.[lastClose.index] : undefined;
  const tsSec = isNum(meta.regularMarketTime) ? meta.regularMarketTime : isNum(lastTs) ? lastTs : undefined;
  if (tsSec === undefined) throw new YahooError(`No timestamp for ${info.yahoo}`);

  const prevClose = [meta.previousClose, meta.chartPreviousClose].find((v): v is number => isNum(v) && v > 0);
  const changePct = prevClose
    ? ((price - prevClose) / prevClose) * 100
    : isNum(meta.regularMarketChangePercent)
      ? meta.regularMarketChangePercent
      : 0;

  return {
    symbol: info.symbol,
    market: info.market,
    price,
    change_pct: round(changePct, 2),
    volume: isNum(meta.regularMarketVolume) ? meta.regularMarketVolume : 0,
    ts: tsSec * 1000,
    source: 'yahoo',
  };
}

/**
 * Parses a `KRW=X` `interval=1m&range=1d` chart response: `meta.regularMarketPrice` (else the
 * last 1m close), `regularMarketTime`, change vs `previousClose`/`chartPreviousClose`.
 */
export function parseYahooFx(json: unknown): FxTick {
  const result = chartResult(json);
  const meta = result.meta ?? {};
  const lastClose = lastValue(result.indicators?.quote?.[0]?.close);
  const rate = isNum(meta.regularMarketPrice) && meta.regularMarketPrice > 0 ? meta.regularMarketPrice : lastClose?.value;
  if (!isNum(rate) || rate <= 0) throw new YahooError(`No rate for ${YAHOO_FX_TICKER}`);
  const lastTs = lastClose ? result.timestamp?.[lastClose.index] : undefined;
  const tsSec = isNum(meta.regularMarketTime) ? meta.regularMarketTime : isNum(lastTs) ? lastTs : undefined;
  if (tsSec === undefined) throw new YahooError(`No timestamp for ${YAHOO_FX_TICKER}`);
  const prevClose = [meta.previousClose, meta.chartPreviousClose].find((v): v is number => isNum(v) && v > 0);
  const changePct = prevClose
    ? ((rate - prevClose) / prevClose) * 100
    : isNum(meta.regularMarketChangePercent)
      ? meta.regularMarketChangePercent
      : 0;
  return { pair: 'USDKRW', rate: round(rate, 4), change_pct: round(changePct, 2), ts: tsSec * 1000, source: 'yahoo' };
}

/** Parses a `interval=1d` chart response into daily bars (oldest first), skipping rows without a close. */
export function parseYahooDailyBars(json: unknown): DailyBar[] {
  return barsFromResult(chartResult(json));
}

function barsFromResult(result: ChartResult): DailyBar[] {
  const timestamps = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const offsetSec = isNum(result.meta?.gmtoffset) ? result.meta.gmtoffset : 0;

  const byDate = new Map<string, DailyBar>();
  timestamps.forEach((ts, i) => {
    const close = q.close?.[i];
    const volume = q.volume?.[i];
    if (!isNum(ts) || !isNum(close)) return;
    // Daily timestamps mark the session open; shifting by the exchange offset yields the local date.
    const date = new Date((ts + offsetSec) * 1000).toISOString().slice(0, 10);
    byDate.set(date, {
      date,
      open: price4(q.open?.[i]),
      high: price4(q.high?.[i]),
      low: price4(q.low?.[i]),
      close: round(close, 4),
      volume: isNum(volume) ? volume : null,
    });
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Smallest chart range that covers `days` trading days. */
export function rangeForDays(days: number): string {
  if (days <= 4) return '5d';
  if (days <= 18) return '1mo';
  if (days <= 60) return '3mo';
  if (days <= 120) return '6mo';
  return '1y';
}

export interface YahooOptions {
  fetchImpl?: FetchLike;
  /** Base delay before the single retry on 429/5xx/network errors. */
  retryDelayMs?: number;
  /** Batch through the spark endpoint (default true); false uses one chart request per symbol. */
  batch?: boolean;
  /** Fetch symbols a successful spark response lacks one by one via the chart endpoint (default true). */
  fallback?: boolean;
  /** Pause after a persistent 429 (default YAHOO_COOLDOWN_MS). */
  cooldownMs?: number;
  /** Clock for the cooldown (default Date.now). */
  clock?: () => number;
}

/** A 429 (from Yahoo, or refused locally while the provider is paused); already logged once. */
const isRateLimited = (err: unknown) => err instanceof YahooError && err.status === 429;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createYahooProvider(opts: YahooOptions = {}): PriceProvider {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const batch = opts.batch ?? true;
  const fallback = opts.fallback ?? true;
  const cooldownMs = opts.cooldownMs ?? YAHOO_COOLDOWN_MS;
  const clock = opts.clock ?? Date.now;
  const limit = createLimiter(MAX_CONCURRENT);
  let pausedUntil = 0;
  const paused = () => clock() < pausedUntil;

  function pause(): void {
    if (!paused()) console.warn(`[yahoo] HTTP 429: pausing Yahoo requests for ${Math.round(cooldownMs / 1000)}s`);
    pausedUntil = Math.max(pausedUntil, clock() + cooldownMs);
  }

  async function getJson(url: string, label: string): Promise<unknown> {
    const init: RequestInit = { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } };

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        // Checked when the request actually starts, so calls queued behind the limiter stop too.
        res = await limit(() => {
          if (paused()) throw new YahooError(`${label}: paused after HTTP 429`, 429);
          return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        });
      } catch (err) {
        if (err instanceof YahooError) throw err;
        if (attempt === 1) {
          await sleep(backoffMs(1, retryDelayMs));
          continue;
        }
        throw new YahooError(`${label}: ${errorMessage(err)}`);
      }

      if (res.ok) return res.json();

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt === 1) {
        await res.body?.cancel();
        await sleep(backoffMs(1, retryDelayMs, res.headers.get('retry-after')));
        continue;
      }
      if (res.status === 429) pause();
      // 404 bodies still carry chart.error (spark: spark.error) with a useful description.
      const body = (await res.json().catch(() => undefined)) as
        | { chart?: { error?: { description?: string } | null }; spark?: { error?: { description?: string } | null } }
        | undefined;
      const description = body?.chart?.error?.description ?? body?.spark?.error?.description;
      throw new YahooError(`${label}: HTTP ${res.status}${description ? ` ${description}` : ''}`, res.status);
    }
  }

  const getChart = (ticker: string, interval: string, range: string) =>
    getJson(`${BASE_URL}${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`, ticker);

  /** One spark call (daily interval) per chunk of at most SPARK_MAX_SYMBOLS; a chunk whose call failed has null results. */
  function sparkChunks(symbols: SymbolInfo[], range: string) {
    return Promise.all(
      chunked(symbols, SPARK_MAX_SYMBOLS).map(async (chunk) => {
        const tickers = [...new Set(chunk.map((s) => s.yahoo))].map(encodeURIComponent).join(',');
        try {
          const json = await getJson(`${SPARK_URL}?symbols=${tickers}&range=${range}&interval=1d`, `spark(${chunk.length})`);
          return { chunk, results: parseYahooSpark(json) as Map<string, ChartResult> | null };
        } catch (err) {
          if (!isRateLimited(err)) console.warn(`[yahoo] spark batch of ${chunk.length} failed: ${errorMessage(err)}`);
          return { chunk, results: null };
        }
      }),
    );
  }

  async function chartQuotes(symbols: SymbolInfo[]): Promise<Quote[]> {
    const settled = await Promise.allSettled(
      symbols.map(async (info) => parseYahooQuote(await getChart(info.yahoo, '1m', '1d'), info)),
    );
    const quotes: Quote[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') quotes.push(r.value);
      else if (!isRateLimited(r.reason)) console.warn(`[yahoo] quote ${symbols[i]!.yahoo} failed: ${errorMessage(r.reason)}`);
    });
    return quotes;
  }

  return {
    name: 'yahoo',

    async fetchQuotes(symbols) {
      if (paused()) return []; // the collector keeps the cached quotes
      if (!batch) return chartQuotes(symbols);
      const found = new Map<string, Quote>();
      const missing: SymbolInfo[] = [];
      for (const { chunk, results } of await sparkChunks(symbols, '1d')) {
        // A failed call (HTTP error after the retry, network error, pause) affects the whole chunk:
        // those symbols keep their cached quotes until the next tick instead of 20 chart calls.
        if (!results) continue;
        for (const info of chunk) {
          const result = results.get(info.yahoo);
          try {
            if (!result) throw new YahooError(`${info.yahoo} missing from spark`);
            found.set(info.symbol, quoteFromResult(result, info));
          } catch {
            missing.push(info);
          }
        }
      }
      if (missing.length > 0 && !paused()) {
        if (fallback) for (const q of await chartQuotes(missing)) found.set(q.symbol, q);
        else console.warn(`[yahoo] ${missing.length} symbols missing from spark (no fallback)`);
      }
      // Input order, like the per-symbol path.
      return symbols.flatMap((info) => found.get(info.symbol) ?? []);
    },

    async fetchDailyBars(info, days) {
      const bars = parseYahooDailyBars(await getChart(info.yahoo, '1d', rangeForDays(days)));
      return bars.slice(-days);
    },

    async fetchDailyBarsMany(symbols, days) {
      const out = new Map<string, DailyBar[]>();
      if (!batch || paused()) return out;
      for (const { chunk, results } of await sparkChunks(symbols, rangeForDays(days))) {
        for (const info of chunk) {
          const result = results?.get(info.yahoo);
          if (!result) continue;
          const bars = barsFromResult(result).slice(-days);
          if (bars.length > 0) out.set(info.symbol, bars);
        }
      }
      return out;
    },

    async fetchFx() {
      return parseYahooFx(await getChart(YAHOO_FX_TICKER, '1m', '1d'));
    },
  };
}
