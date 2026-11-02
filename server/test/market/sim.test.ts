import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, resetDb } from '../../src/db/db';
import { setNow } from '../../src/lib/time';
import { isTradingDay } from '../../src/market/calendar';
import type { Quote } from '../../../shared/api-types';
import { basePrice, createSimProvider, roundToTick, seededRandom, startPrice, tickSize } from '../../src/market/providers/sim';
import { getSymbol, SYMBOLS, type SymbolInfo } from '../../src/market/symbols';

const T0 = Date.UTC(2026, 9, 19, 1, 0); // Mon 2026-10-19 10:00 KST
const apple = getSymbol('AAPL')!;
const samsung = getSymbol('005930')!;
const MINUTE = 60_000;

beforeEach(() => {
  resetDb();
  setNow(() => T0);
});

afterEach(() => {
  setNow(null);
  vi.restoreAllMocks();
});

async function walk(steps: number, symbols = [apple, samsung]) {
  const provider = createSimProvider();
  const out: number[][] = [];
  for (let i = 0; i < steps; i++) out.push((await provider.fetchQuotes(symbols)).map((q) => q.price));
  return out;
}

describe('sim provider', () => {
  it('is deterministic per symbol', async () => {
    expect(await walk(20)).toEqual(await walk(20));
    expect(seededRandom('AAPL')()).toBe(seededRandom('AAPL')());
    expect(seededRandom('AAPL')()).not.toBe(seededRandom('MSFT')());
  });

  it('does not depend on which other symbols are requested', async () => {
    const together = (await walk(10, [apple, samsung])).map((row) => row[0]);
    const alone = (await walk(10, [apple])).map((row) => row[0]);
    expect(together).toEqual(alone);
  });

  it('moves at most 0.3% (× |leverage|) per tick (plus tick rounding) and quotes tick-aligned KR prices', async () => {
    const provider = createSimProvider();
    let prev = await provider.fetchQuotes(SYMBOLS);
    for (let i = 0; i < 50; i++) {
      const next = await provider.fetchQuotes(SYMBOLS);
      next.forEach((q, j) => {
        const p = prev[j]!.price;
        // Both prices carry up to half a tick of rounding on top of the 0.3% move.
        const leverage = Math.max(1, Math.abs(SYMBOLS[j]!.leverage));
        const tolerance = p * 0.003 * leverage * 1.01 + 2 * tickSize(q.market, Math.max(p, q.price));
        expect(Math.abs(q.price - p)).toBeLessThanOrEqual(tolerance);
        if (q.market === 'KR') expect(q.price).toBe(roundToTick('KR', q.price));
        expect(q.source).toBe('sim');
        expect(q.ts).toBe(T0);
      });
      prev = next;
    }
  });

  it('starts from the latest quote row, else the latest daily close, else the base table', () => {
    expect(startPrice(apple)).toBe(344.63);
    db.prepare("INSERT INTO daily_bars (symbol, date, close) VALUES ('AAPL', '2026-10-16', 300)").run();
    expect(startPrice(apple)).toBe(300);
    db.prepare("INSERT INTO quotes (symbol, ts, price, source) VALUES ('AAPL', ?, 250, 'yahoo')").run(T0 - MINUTE);
    db.prepare("INSERT INTO quotes (symbol, ts, price, source) VALUES ('AAPL', ?, 200, 'yahoo')").run(T0 - 10 * MINUTE);
    expect(startPrice(apple)).toBe(250);
  });

  it('has a built-in base price for every symbol', () => {
    expect(SYMBOLS.filter((s) => !(basePrice(s.symbol)! > 0)).map((s) => s.symbol)).toEqual([]);
  });

  it('moves a leveraged/inverse ETF by leverage × its underlying tick return', async () => {
    const qqq = getSymbol('QQQ')!;
    const sqqq = getSymbol('SQQQ')!;
    const tqqq = getSymbol('TQQQ')!;
    const provider = createSimProvider();
    // Raw (unrounded) returns are not observable, so compare cent-rounded prices loosely.
    let prev = await provider.fetchQuotes([sqqq, qqq, tqqq]);
    for (let i = 0; i < 30; i++) {
      const next = await provider.fetchQuotes([sqqq, qqq, tqqq]);
      const r = (k: number) => next[k]!.price / prev[k]!.price - 1;
      const cents = (k: number) => 0.011 / prev[k]!.price;
      expect(Math.abs(r(0) - -3 * r(1))).toBeLessThanOrEqual(cents(0) + 3 * cents(1));
      expect(Math.abs(r(2) - 3 * r(1))).toBeLessThanOrEqual(cents(2) + 3 * cents(1));
      prev = next;
    }
  });

  it('steps an underlying once per call even when it is not requested, so ETF paths do not depend on the request', async () => {
    const qqq = getSymbol('QQQ')!;
    const sqqq = getSymbol('SQQQ')!;
    const alone = (await walk(10, [sqqq])).map((row) => row[0]);
    const withUnderlying = (await walk(10, [qqq, sqqq])).map((row) => row[1]);
    expect(alone).toEqual(withUnderlying);
  });

  it('seeds start prices once from real quotes when nothing is stored (best effort)', async () => {
    const seen: SymbolInfo[][] = [];
    const seed = async (symbols: SymbolInfo[]): Promise<Quote[]> => {
      seen.push(symbols);
      return [{ symbol: 'AAPL', market: 'US', price: 400, change_pct: 1, volume: 0, ts: T0, source: 'yahoo' }];
    };
    db.prepare("INSERT INTO quotes (symbol, ts, price, source) VALUES ('005930', ?, 70000, 'sim')").run(T0 - MINUTE);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = createSimProvider({ seed });
    const [a, s] = await provider.fetchQuotes([apple, samsung]);
    await provider.fetchQuotes([apple]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((x) => x.symbol)).not.toContain('005930'); // has a stored quote
    expect(a!.price).toBeGreaterThan(398);
    expect(a!.price).toBeLessThan(402);
    // change_pct is measured against the seeded quote's previous close (400 / 1.01).
    expect(a!.change_pct).toBeCloseTo(((a!.price - 400 / 1.01) / (400 / 1.01)) * 100, 1);
    expect(s!.price).toBeGreaterThan(69_000);
    expect(s!.price).toBeLessThan(71_000);
  });

  it('falls back to base prices when seeding fails or times out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = createSimProvider({ seed: async () => Promise.reject(new Error('offline')) });
    const [a] = await failing.fetchQuotes([apple]);
    expect(Math.abs(a!.price - 344.63)).toBeLessThan(2);
    const hanging = createSimProvider({ seed: () => new Promise<Quote[]>(() => undefined), seedTimeoutMs: 20 });
    const [b] = await hanging.fetchQuotes([apple]);
    expect(Math.abs(b!.price - 344.63)).toBeLessThan(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports change_pct against the previous daily close', async () => {
    db.prepare("INSERT INTO daily_bars (symbol, date, close) VALUES ('AAPL', '2026-10-16', 100)").run();
    db.prepare("INSERT INTO quotes (symbol, ts, price, source) VALUES ('AAPL', ?, 110, 'yahoo')").run(T0 - MINUTE);
    const [q] = await createSimProvider().fetchQuotes([apple]);
    expect(q!.price).toBeGreaterThan(109);
    expect(q!.change_pct).toBeCloseTo(((q!.price - 100) / 100) * 100, 2);
  });

  it('accumulates volume within a day and resets it on a new market day', async () => {
    const provider = createSimProvider();
    const volumes: number[] = [];
    let last = (await provider.fetchQuotes([samsung]))[0]!;
    volumes.push(last.volume);
    for (let i = 0; i < 9; i++) {
      last = (await provider.fetchQuotes([samsung]))[0]!;
      volumes.push(last.volume);
    }
    expect(volumes).toEqual([...volumes].sort((x, y) => x - y));
    // Ten KR increments are at least 10 × 4,000; a single one is at most 24,000.
    expect(last.volume).toBeGreaterThan(24_000);

    setNow(() => T0 + 86_400_000);
    const next = (await provider.fetchQuotes([samsung]))[0]!;
    expect(next.volume).toBeLessThanOrEqual(24_000);
    expect(next.change_pct).toBeCloseTo(((next.price - last.price) / last.price) * 100, 1);
  });

  it('generates trading-day bars that end at the start price when none are stored', async () => {
    const bars = await createSimProvider().fetchDailyBars(samsung, 10);
    expect(bars).toHaveLength(10);
    const dates = bars.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
    expect(dates.every((d) => isTradingDay('KR', d) && d < '2026-10-19')).toBe(true);
    expect(bars.at(-1)!.close).toBe(roundToTick('KR', startPrice(samsung)));
    for (const b of bars) {
      expect(b.high!).toBeGreaterThanOrEqual(Math.max(b.open!, b.close));
      expect(b.low!).toBeLessThanOrEqual(Math.min(b.open!, b.close));
    }
  });

  it('returns stored bars instead of overwriting them', async () => {
    const insert = db.prepare("INSERT INTO daily_bars (symbol, date, close) VALUES ('AAPL', ?, ?)");
    insert.run('2026-10-15', 10);
    insert.run('2026-10-16', 11);
    insert.run('2026-10-14', 9);
    const bars = await createSimProvider().fetchDailyBars(apple, 2);
    expect(bars.map((b) => [b.date, b.close])).toEqual([
      ['2026-10-15', 10],
      ['2026-10-16', 11],
    ]);
  });
});
