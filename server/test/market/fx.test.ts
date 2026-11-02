import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FxQuote } from '../../../shared/api-types';
import { config } from '../../src/config';
import { db, resetDb } from '../../src/db/db';
import { bus } from '../../src/lib/bus';
import { setNow } from '../../src/lib/time';
import { createCollector } from '../../src/market/collector';
import { appliedFx, clearFx, FX_STALE_MS, fxAt, getFx, isFxStale, loadStoredFx, setFx, storeFx } from '../../src/market/fx';
import { createKisProvider } from '../../src/market/providers/kis';
import { createSimProvider, SIM_FX_BASE } from '../../src/market/providers/sim';
import type { FxTick, PriceProvider } from '../../src/market/providers/types';
import { createYahooProvider, parseYahooFx, YahooError } from '../../src/market/providers/yahoo';
import { clearQuotes } from '../../src/market/quoteCache';
import { fixture, jsonResponse } from './fixtures';

const T0 = Date.UTC(2026, 9, 19, 1, 0); // Mon 2026-10-19 10:00 KST
const SATURDAY = Date.UTC(2026, 9, 17, 3, 0);
const MINUTE = 60_000;
let clock = T0;

const tick = (rate: number, ts: number, source: FxTick['source'] = 'sim'): FxTick => ({
  pair: 'USDKRW',
  rate,
  change_pct: 0,
  ts,
  source,
});

beforeEach(() => {
  resetDb();
  clearFx();
  clearQuotes();
  clock = T0;
  setNow(() => clock);
  config.simAlwaysOpen = false;
});

afterEach(() => {
  setNow(null);
  clearFx();
  vi.restoreAllMocks();
});

describe('parseYahooFx (real KRW=X 1m chart, 2026-10-31)', () => {
  it('reads the mid from meta.regularMarketPrice and the change vs the previous close', () => {
    expect(parseYahooFx(fixture('yahoo-chart-1m-KRW=X.json'))).toEqual({
      pair: 'USDKRW',
      rate: 1335.1,
      change_pct: -0.29, // vs previousClose 1338.99
      ts: 1793417451000,
      source: 'yahoo',
    });
  });

  it('falls back to the last 1m close and throws without any rate', () => {
    const json = fixture('yahoo-chart-1m-KRW=X.json');
    delete json.chart.result[0].meta.regularMarketPrice;
    expect(parseYahooFx(json).rate).toBe(1333.4399);
    json.chart.result[0].indicators.quote[0].close = [null];
    expect(() => parseYahooFx(json)).toThrow(YahooError);
  });

  it('fetches KRW=X with its own chart call; KIS delegates to it', async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse(fixture('yahoo-chart-1m-KRW=X.json')));
    const yahoo = createYahooProvider({ fetchImpl });
    expect((await yahoo.fetchFx!()).rate).toBe(1335.1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://query1.finance.yahoo.com/v8/finance/chart/KRW%3DX?interval=1m&range=1d');

    const kis = createKisProvider({ appKey: 'k', appSecret: 's', baseUrl: 'https://kis.example', fetchImpl, dailyBars: yahoo });
    expect((await kis.fetchFx!()).rate).toBe(1335.1);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // no KIS call
  });
});

describe('fx cache and history', () => {
  it('keeps the newest rate, flags it stale after 30 minutes and converts with the spread', () => {
    expect(getFx()).toBeNull();
    setFx(tick(1300, T0));
    setFx(tick(1290, T0 - MINUTE)); // older fetch never wins
    expect(getFx()).toEqual({ pair: 'USDKRW', rate: 1300, change_pct: 0, ts: T0, source: 'sim', stale: false });
    expect(isFxStale({ ts: T0 }, T0 + FX_STALE_MS)).toBe(false);
    expect(getFx(T0 + FX_STALE_MS + 1)?.stale).toBe(true);
    expect(appliedFx(1335.1, 'BUY', 0.001)).toBe(1336.4351);
    expect(appliedFx(1335.1, 'SELL', 0.001)).toBe(1333.7649);
  });

  it('stores one row per source timestamp, never replacing one, and answers the rate at a time', () => {
    storeFx(tick(1300, T0 + 5_000));
    storeFx(tick(1301, T0 + 40_000)); // same minute: its own row, the 1300 row stays
    storeFx(tick(1399, T0 + 40_000)); // same tick fetched again: ignored
    storeFx(tick(1310, T0 + MINUTE));
    expect(db.prepare('SELECT ts, rate FROM fx_rates ORDER BY ts').all()).toEqual([
      { ts: T0 + 5_000, rate: 1300 },
      { ts: T0 + 40_000, rate: 1301 },
      { ts: T0 + MINUTE, rate: 1310 },
    ]);
    expect(fxAt(T0 + 4_999)).toBeUndefined();
    expect(fxAt(T0 + 39_999)).toBe(1300);
    expect(fxAt(T0 + 59_999)).toBe(1301);
    expect(fxAt(T0 + 10 * MINUTE)).toBe(1310);
  });

  it('loadStoredFx seeds the cache from the latest fx_rates row with its stored ts (stale until a fresh fetch)', () => {
    loadStoredFx();
    expect(getFx()).toBeNull(); // nothing stored: still no rate
    storeFx(tick(1290, T0 - 2 * FX_STALE_MS, 'yahoo'));
    storeFx(tick(1300, T0 - FX_STALE_MS - 1, 'yahoo'));
    loadStoredFx();
    expect(getFx()).toEqual({ pair: 'USDKRW', rate: 1300, change_pct: 0, ts: T0 - FX_STALE_MS - 1, source: 'yahoo', stale: true });
    setFx(tick(1333, T0));
    loadStoredFx(); // never replaces a newer rate
    expect(getFx()?.rate).toBe(1333);
  });
});

describe('sim USD/KRW', () => {
  async function rates(steps: number, provider = createSimProvider()): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < steps; i++) out.push((await provider.fetchFx!()).rate);
    return out;
  }

  it('walks deterministically from the built-in base by at most 0.02% per tick', async () => {
    const a = await rates(30);
    expect(await rates(30)).toEqual(a);
    let prev = SIM_FX_BASE;
    for (const r of a) {
      expect(Math.abs(r / prev - 1)).toBeLessThanOrEqual(0.0002 + 0.00001);
      prev = r;
    }
    const fx = await createSimProvider().fetchFx!();
    expect(fx).toMatchObject({ pair: 'USDKRW', ts: T0, source: 'sim' });
  });

  it('starts from the latest fx_rates row, else the seed, else the base', async () => {
    const seedFx = vi.fn(async () => tick(1400, T0, 'yahoo'));
    const seeded = await createSimProvider({ seedFx }).fetchFx!();
    expect(seedFx).toHaveBeenCalledTimes(1);
    expect(Math.abs(seeded.rate / 1400 - 1)).toBeLessThanOrEqual(0.00021);

    storeFx(tick(1250, T0 - MINUTE));
    const unusedSeed = vi.fn(async () => tick(1400, T0, 'yahoo'));
    const fromDb = await createSimProvider({ seedFx: unusedSeed }).fetchFx!();
    expect(unusedSeed).not.toHaveBeenCalled();
    expect(Math.abs(fromDb.rate / 1250 - 1)).toBeLessThanOrEqual(0.00021);

    resetDb();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = await createSimProvider({ seedFx: async () => Promise.reject(new Error('offline')) }).fetchFx!();
    expect(Math.abs(failing.rate / SIM_FX_BASE - 1)).toBeLessThanOrEqual(0.00021);
  });
});

describe('collector USD/KRW', () => {
  function provider(): PriceProvider & { fetchFx: ReturnType<typeof vi.fn> } {
    return {
      name: 'sim',
      fetchQuotes: vi.fn(async () => []),
      fetchDailyBars: vi.fn(async () => []),
      fetchFx: vi.fn(async () => tick(1333, clock)),
    };
  }

  it('fetches FX each tick while a market is open: stores, caches and emits it', async () => {
    const p = provider();
    const events: FxQuote[] = [];
    const listener = (fx: FxQuote) => events.push(fx);
    bus.on('fx', listener);
    try {
      await createCollector(p).tick();
      clock += MINUTE;
      await createCollector(p).tick();
    } finally {
      bus.off('fx', listener);
    }
    expect(p.fetchFx).toHaveBeenCalledTimes(2);
    expect(getFx()).toMatchObject({ rate: 1333, ts: T0 + MINUTE, stale: false });
    expect(events.map((e) => e.ts)).toEqual([T0, T0 + MINUTE]);
    expect(fxAt(T0 + MINUTE)).toBe(1333);
  });

  it('fetches FX only until one is cached while both markets are closed, and survives failures', async () => {
    clock = SATURDAY;
    const p = provider();
    p.fetchFx.mockRejectedValueOnce(new Error('down'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const collector = createCollector(p);
    await collector.tick();
    expect(getFx()).toBeNull();
    await collector.tick();
    await collector.tick();
    expect(p.fetchFx).toHaveBeenCalledTimes(2);
    expect(getFx()?.rate).toBe(1333);
  });

  it('still fetches FX once while both markets are closed when the cached rate was seeded at boot', async () => {
    clock = SATURDAY;
    storeFx(tick(1300, SATURDAY - 3 * 24 * 60 * MINUTE));
    loadStoredFx();
    const p = provider();
    const collector = createCollector(p);
    await collector.tick();
    await collector.tick();
    expect(p.fetchFx).toHaveBeenCalledTimes(1);
    expect(getFx()).toMatchObject({ rate: 1333, ts: SATURDAY, stale: false });
  });
});
