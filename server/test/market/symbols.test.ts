import { describe, expect, it } from 'vitest';
import { getSymbol, isLeveraged, SYMBOLS, symbolsFor } from '../../src/market/symbols';

describe('symbol universe', () => {
  it('has unique codes and Yahoo tickers', () => {
    expect(new Set(SYMBOLS.map((s) => s.symbol)).size).toBe(SYMBOLS.length);
    expect(new Set(SYMBOLS.map((s) => s.yahoo)).size).toBe(SYMBOLS.length);
  });

  it('covers both markets with stocks, ETFs and leveraged/inverse products', () => {
    const count = (market: 'KR' | 'US', pred: (s: (typeof SYMBOLS)[number]) => boolean) =>
      symbolsFor(market).filter(pred).length;
    expect(count('KR', (s) => s.kind === 'stock')).toBeGreaterThanOrEqual(60);
    expect(count('KR', (s) => s.kind === 'etf')).toBeGreaterThanOrEqual(25);
    expect(count('US', (s) => s.kind === 'stock')).toBeGreaterThanOrEqual(100);
    expect(count('US', (s) => s.kind === 'etf')).toBeGreaterThanOrEqual(50);
    for (const m of ['KR', 'US'] as const) {
      expect(count(m, (s) => s.leverage > 1)).toBeGreaterThan(0);
      expect(count(m, (s) => s.leverage < 0)).toBeGreaterThan(0);
    }
  });

  it('uses the right code format, suffix and exchange per market', () => {
    for (const s of SYMBOLS) {
      if (s.market === 'KR') {
        expect(s.symbol, s.symbol).toMatch(/^\d{6}$/);
        expect(['KOSPI', 'KOSDAQ']).toContain(s.exchange);
        expect(s.yahoo).toBe(`${s.symbol}.${s.exchange === 'KOSPI' ? 'KS' : 'KQ'}`);
        expect(s.kisExchange).toBeUndefined();
        if (s.kind === 'etf') expect(s.exchange, s.symbol).toBe('KOSPI');
      } else {
        expect(s.symbol, s.symbol).toMatch(/^[A-Z]{1,5}$/);
        expect(s.yahoo).toBe(s.symbol);
        expect(['NASDAQ', 'NYSE', 'NYSE Arca', 'Cboe BZX']).toContain(s.exchange);
        const kis = { NASDAQ: 'NAS', NYSE: 'NYS', 'NYSE Arca': 'AMS', 'Cboe BZX': 'AMS' }[s.exchange as string];
        expect(s.kisExchange, s.symbol).toBe(kis);
      }
      expect(s.name.trim(), s.symbol).not.toBe('');
      expect(s.category.trim(), s.symbol).not.toBe('');
    }
  });

  it('gives leverage only to ETFs and an existing same-market underlying to leveraged/inverse ETFs', () => {
    for (const s of SYMBOLS) {
      if (s.kind === 'stock') {
        expect(s.leverage, s.symbol).toBe(1);
        expect(s.underlying, s.symbol).toBeUndefined();
        continue;
      }
      expect([1, 1.5, 2, 3, -1, -2, -3], s.symbol).toContain(s.leverage);
      if (s.underlying) {
        const u = getSymbol(s.underlying);
        expect(u, `${s.symbol} -> ${s.underlying}`).toBeDefined();
        expect(u!.market).toBe(s.market);
        expect(isLeveraged(u!), `${s.underlying} must be a 1× instrument`).toBe(false);
        expect(isLeveraged(s), `${s.symbol} has an underlying but tracks 1×`).toBe(true);
      }
      if (isLeveraged(s)) expect(['레버리지', '인버스', '변동성'], s.symbol).toContain(s.category);
    }
    // Inverse / leveraged products named as such carry the matching sign.
    expect(getSymbol('SQQQ')).toMatchObject({ leverage: -3, underlying: 'QQQ' });
    expect(getSymbol('TQQQ')).toMatchObject({ leverage: 3, underlying: 'QQQ' });
    expect(getSymbol('122630')).toMatchObject({ name: 'KODEX 레버리지', leverage: 2, underlying: '069500' });
    expect(getSymbol('252670')).toMatchObject({ name: 'KODEX 200선물인버스2X', leverage: -2, underlying: '069500' });
    expect(getSymbol('114800')).toMatchObject({ name: 'KODEX 인버스', leverage: -1, underlying: '069500' });
    for (const s of SYMBOLS.filter((x) => /인버스|베어|숏/.test(x.name))) expect(s.leverage, s.symbol).toBeLessThan(0);
  });

  it('keeps the original 30 + 30 pool', () => {
    for (const code of ['005930', '000660', '247540', '028300', 'AAPL', 'WMT', 'JPM', 'DIS']) {
      expect(getSymbol(code)?.kind, code).toBe('stock');
    }
  });
});
