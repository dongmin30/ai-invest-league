import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { setNow } from '../../src/lib/time';
import { marketStatus } from '../../src/market';
import {
  currentSessionEnd,
  isLeagueTradable,
  isMarketOpen,
  isMarketTradable,
  marketSession,
  nextTradable,
} from '../../src/market/calendar';
import { parseYahooQuote } from '../../src/market/providers/yahoo';
import { getSymbol } from '../../src/market/symbols';

const edt = (mo: number, d: number, h: number, mi = 0, s = 0, ms = 0) => Date.UTC(2026, mo - 1, d, h + 4, mi, s, ms);
const est = (mo: number, d: number, h: number, mi = 0, s = 0, ms = 0) => Date.UTC(2026, mo - 1, d, h + 5, mi, s, ms);
const kst = (mo: number, d: number, h: number, mi = 0) => Date.UTC(2026, mo - 1, d, h - 9, mi);

const saved = {
  priceProvider: config.priceProvider,
  kisAppKey: config.kisAppKey,
  kisAppSecret: config.kisAppSecret,
  simAlwaysOpen: config.simAlwaysOpen,
};

beforeEach(() => {
  Object.assign(config, { priceProvider: 'yahoo', kisAppKey: undefined, kisAppSecret: undefined, simAlwaysOpen: false });
});

afterEach(() => {
  Object.assign(config, saved);
  setNow(null);
});

describe('marketSession', () => {
  it('splits a US trading day into pre, regular, post and closed (EDT)', () => {
    expect(marketSession('US', edt(10, 19, 3, 59))).toBe('closed');
    expect(marketSession('US', edt(10, 19, 4, 0))).toBe('pre');
    expect(marketSession('US', edt(10, 19, 9, 29, 59))).toBe('pre');
    expect(marketSession('US', edt(10, 19, 9, 30))).toBe('regular');
    expect(marketSession('US', edt(10, 19, 16, 0))).toBe('regular');
    expect(marketSession('US', edt(10, 19, 16, 0, 0, 1))).toBe('post');
    expect(marketSession('US', edt(10, 19, 20, 0))).toBe('post');
    expect(marketSession('US', edt(10, 19, 20, 0, 0, 1))).toBe('closed');
  });

  it('follows daylight saving time (EST)', () => {
    expect(marketSession('US', est(11, 9, 4, 0))).toBe('pre');
    expect(marketSession('US', edt(11, 9, 4, 0))).toBe('closed'); // 03:00 EST
  });

  it('has no extended hours on weekends and holidays', () => {
    expect(marketSession('US', edt(10, 17, 10))).toBe('closed'); // Saturday
    expect(marketSession('US', est(11, 26, 10))).toBe('closed'); // Thanksgiving
  });

  it('has no extended hours for KR', () => {
    expect(marketSession('KR', kst(10, 19, 8, 30))).toBe('closed');
    expect(marketSession('KR', kst(10, 19, 10))).toBe('regular');
    expect(marketSession('KR', kst(10, 19, 17))).toBe('closed');
  });

  it('has no extended hours with active KIS quotes, which cover the regular session only', () => {
    Object.assign(config, { priceProvider: 'kis', kisAppKey: 'k', kisAppSecret: 's' });
    expect(marketSession('US', edt(10, 19, 8))).toBe('closed');
    expect(marketSession('US', edt(10, 19, 10))).toBe('regular');
  });

  it('keeps extended hours when KIS falls back to Yahoo for missing keys', () => {
    config.priceProvider = 'kis';
    expect(marketSession('US', edt(10, 19, 8))).toBe('pre');
  });

  it('leaves the regular-session check untouched', () => {
    expect(isMarketOpen('US', edt(10, 19, 8))).toBe(false);
    expect(isMarketTradable('US', edt(10, 19, 8))).toBe(true);
  });

  it('counts extended hours for leagues', () => {
    expect(isLeagueTradable('US', edt(10, 19, 8))).toBe(true);
    expect(isLeagueTradable('ALL', edt(10, 19, 8))).toBe(true);
    expect(isLeagueTradable('KR', edt(10, 19, 8))).toBe(false); // 21:00 KST
  });
});

describe('nextTradable and currentSessionEnd', () => {
  it('starts at the pre-market for the US and the regular open for KR', () => {
    expect(nextTradable('US', edt(10, 16, 21))).toBe(edt(10, 19, 4)); // Friday night → Monday
    expect(nextTradable('US', edt(10, 19, 3))).toBe(edt(10, 19, 4));
    expect(nextTradable('KR', kst(10, 19, 16))).toBe(kst(10, 20, 9));
  });

  it('ends each part of the day where the next one begins', () => {
    expect(currentSessionEnd('US', edt(10, 19, 8))).toBe(edt(10, 19, 9, 30));
    expect(currentSessionEnd('US', edt(10, 19, 12))).toBe(edt(10, 19, 16));
    expect(currentSessionEnd('US', edt(10, 19, 18))).toBe(edt(10, 19, 20));
  });
});

describe('marketStatus in extended hours', () => {
  it('reports the pre-market as open and names the session', () => {
    setNow(() => edt(10, 19, 8));
    expect(marketStatus('US')).toMatchObject({
      open: true,
      session: 'pre',
      next_open: null,
      next_close: edt(10, 19, 9, 30),
    });
  });

  it('reports the next pre-market when closed', () => {
    setNow(() => edt(10, 19, 21));
    expect(marketStatus('US')).toMatchObject({ open: false, session: 'closed', next_open: edt(10, 20, 4) });
  });
});

describe('parseYahooQuote with pre- and after-market bars', () => {
  const apple = getSymbol('AAPL')!;
  const samsung = getSymbol('005930')!;
  const sec = (ms: number) => ms / 1000;
  const FRIDAY_CLOSE = sec(est(11, 6, 16, 0, 1));
  const TODAY_CLOSE = sec(est(11, 9, 16, 0, 1));

  const chart = (regularTime: number, barTime: number, price: number) => ({
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: 342.37,
            regularMarketTime: regularTime,
            regularMarketVolume: 1000,
            previousClose: 344.5,
            chartPreviousClose: 344.5,
          },
          timestamp: [barTime],
          indicators: { quote: [{ close: [price] }] },
        },
      ],
    },
  });

  it('uses the newest pre-market trade, compared with the last regular close', () => {
    const barTime = sec(est(11, 9, 7, 34, 42));
    const q = parseYahooQuote(chart(FRIDAY_CLOSE, barTime, 345.8937), apple);
    expect(q).toMatchObject({ price: 345.8937, ts: barTime * 1000, change_pct: 1.03 });
  });

  it('uses an after-market trade past the closing-print window, compared with the previous close', () => {
    const barTime = sec(est(11, 9, 16, 30));
    const q = parseYahooQuote(chart(TODAY_CLOSE, barTime, 341.7), apple);
    expect(q).toMatchObject({ price: 341.7, ts: barTime * 1000, change_pct: -0.81 });
  });

  it('keeps the official close during the closing-print window', () => {
    const q = parseYahooQuote(chart(TODAY_CLOSE, sec(est(11, 9, 16, 5)), 341.7), apple);
    expect(q).toMatchObject({ price: 342.37, ts: TODAY_CLOSE * 1000 });
  });

  it('keeps the regular price during the regular session', () => {
    const regular = sec(est(11, 9, 12));
    const q = parseYahooQuote(chart(regular, regular + 30, 341.7), apple);
    expect(q).toMatchObject({ price: 342.37, ts: regular * 1000 });
  });

  it('ignores bars outside the extended hours', () => {
    const q = parseYahooQuote(chart(FRIDAY_CLOSE, sec(est(11, 9, 3, 30)), 341.7), apple);
    expect(q).toMatchObject({ price: 342.37, ts: FRIDAY_CLOSE * 1000 });
  });

  it('never uses after-hours bars for KR symbols', () => {
    const close = sec(kst(11, 9, 15, 30));
    const q = parseYahooQuote(chart(close, sec(kst(11, 9, 17)), 341.7), samsung);
    expect(q).toMatchObject({ price: 342.37, ts: close * 1000 });
  });
});
