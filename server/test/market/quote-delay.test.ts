import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config';
import { updateLeagueStatuses } from '../../src/engine/leagues';
import { matchOrders } from '../../src/engine/matcher';
import { cancelOrder, EngineError } from '../../src/engine/orders';
import { marketStatus } from '../../src/market';
import { awaitingClosingPrint, cancelLockedUntil, closingPrintWaitMs, krAuctionPending, marketSession, quoteDelayMs } from '../../src/market/calendar';
import { createCollector } from '../../src/market/collector';
import { krFromKis } from '../../src/market/providers/kis';
import type { PriceProvider } from '../../src/market/providers/types';
import { getQuote, isStale } from '../../src/market/quoteCache';
import { SYMBOLS } from '../../src/market/symbols';
import { db } from '../../src/db/db';
import { HOUR, KR_CLOSE, KR_OPEN, MIN, activeLeague, buy, clockNow, feed, quote, resetEngineState, restoreEngineState, setClock } from '../engine/helpers';

const SAMSUNG = '005930';
const DELAY = 20 * MIN;
const LAG = DELAY + 2 * MIN; // delay + two 60 s collect intervals
const saved = {
  priceProvider: config.priceProvider,
  kisAppKey: config.kisAppKey,
  kisAppSecret: config.kisAppSecret,
  collectIntervalSec: config.collectIntervalSec,
};

beforeEach(() => {
  resetEngineState();
  Object.assign(config, { priceProvider: 'yahoo', kisAppKey: undefined, kisAppSecret: undefined, collectIntervalSec: 60 });
});

afterEach(() => {
  restoreEngineState();
  Object.assign(config, saved);
  vi.restoreAllMocks();
});

describe('quoteDelayMs', () => {
  it('is 20 minutes for KR on Yahoo and zero for the US', () => {
    expect(quoteDelayMs('KR')).toBe(DELAY);
    expect(quoteDelayMs('US')).toBe(0);
  });

  it('is 20 minutes when KIS is selected without keys, since Yahoo is the fallback', () => {
    config.priceProvider = 'kis_kr';
    expect(quoteDelayMs('KR')).toBe(DELAY);
    config.priceProvider = 'kis';
    expect(quoteDelayMs('KR')).toBe(DELAY);
  });

  it('keeps US extended hours with kis_kr but not with kis', () => {
    const preMarket = Date.UTC(2026, 9, 19, 9, 0); // 05:00 EDT
    Object.assign(config, { priceProvider: 'kis_kr', kisAppKey: 'k', kisAppSecret: 's' });
    expect(marketSession('US', preMarket)).toBe('pre');
    config.priceProvider = 'kis';
    expect(marketSession('US', preMarket)).toBe('closed');
  });

  it('is zero with KIS keys or the simulator', () => {
    Object.assign(config, { priceProvider: 'kis_kr', kisAppKey: 'k', kisAppSecret: 's' });
    expect(quoteDelayMs('KR')).toBe(0);
    config.priceProvider = 'kis';
    expect(quoteDelayMs('KR')).toBe(0);
    Object.assign(config, { priceProvider: 'sim', kisAppKey: undefined, kisAppSecret: undefined });
    expect(quoteDelayMs('KR')).toBe(0);
  });
});

describe('waiting for a delayed closing print', () => {
  it('extends the KR wait to 30 minutes and leaves the US at 10', () => {
    expect(closingPrintWaitMs('KR')).toBe(30 * MIN);
    expect(closingPrintWaitMs('US')).toBe(10 * MIN);
    expect(awaitingClosingPrint('KR', KR_CLOSE + 30 * MIN)).toBe(true);
    expect(awaitingClosingPrint('KR', KR_CLOSE + 30 * MIN + 1)).toBe(false);
    expect(awaitingClosingPrint('KR', KR_CLOSE)).toBe(false);
  });

  it('keeps polling KR until the closing print can have arrived', async () => {
    const provider: PriceProvider = {
      name: 'yahoo',
      fetchQuotes: vi.fn(async (symbols: typeof SYMBOLS) =>
        symbols.map((s) => ({ symbol: s.symbol, market: s.market, price: 100, change_pct: 0, volume: 0, ts: clockNow() - DELAY, source: 'yahoo' as const })),
      ),
      fetchDailyBars: async () => [],
    };
    const collector = createCollector(provider);
    setClock(KR_CLOSE + 25 * MIN);
    await collector.tick();
    await collector.tick();
    const krCount = SYMBOLS.filter((s) => s.market === 'KR').length;
    expect((provider.fetchQuotes as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toHaveLength(krCount);

    setClock(KR_CLOSE + 31 * MIN);
    await collector.tick();
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(2);
  });

  it('settles a KR league on the closing print that arrives 20 minutes late', () => {
    const { leagueId, participantId } = activeLeague('KR', { duration_days: 1 });
    feed(quote(SAMSUNG, 70_000));
    const order = buy(participantId, SAMSUNG, 1);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(SAMSUNG, 70_000)));
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(order.id)).toBe('filled');

    // 15:40: the source has only reached 15:20, so the league keeps waiting.
    setClock(KR_CLOSE + 10 * MIN);
    feed(quote(SAMSUNG, 71_000, KR_CLOSE - 10 * MIN));
    expect(updateLeagueStatuses().finished).toEqual([]);

    // 15:50: the 15:30:05 closing print is in.
    setClock(KR_CLOSE + 20 * MIN + 5000);
    feed(quote(SAMSUNG, 72_000, KR_CLOSE + 5000));
    expect(updateLeagueStatuses().finished).toEqual([leagueId]);
    const fee = db.prepare('SELECT fee FROM orders WHERE id = ?').pluck().get(order.id) as number;
    const finalReturn = db.prepare('SELECT final_return FROM participants WHERE id = ?').pluck().get(participantId) as number;
    expect(finalReturn).toBeCloseTo((72_000 - 70_000 - fee) / 10_000_000, 8); // valued at 72,000, not the 71,000 of 15:20
  });

  it('fills an order placed in the closing auction at the print that arrives 20 minutes later', () => {
    const { participantId } = activeLeague('KR', { duration_days: 3 });
    feed(quote(SAMSUNG, 70_000));
    setClock(KR_CLOSE - 5 * MIN);
    const order = buy(participantId, SAMSUNG, 1);

    setClock(KR_CLOSE + 10 * MIN);
    expect(matchOrders(feed(quote(SAMSUNG, 71_000, KR_CLOSE - 10 * MIN)))).toEqual([]);

    setClock(KR_CLOSE + 20 * MIN + 5000);
    const [filled] = matchOrders(feed(quote(SAMSUNG, 72_000, KR_CLOSE + 5000)));
    expect(filled).toMatchObject({ id: order.id, status: 'filled', fill_price: 72_000 });
  });

  it('finishes at close + 30 minutes at the latest when no closing print comes', () => {
    const { leagueId, participantId } = activeLeague('KR', { duration_days: 1 });
    feed(quote(SAMSUNG, 70_000));
    buy(participantId, SAMSUNG, 1);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(SAMSUNG, 70_000)));
    setClock(KR_CLOSE + 30 * MIN - 1);
    expect(updateLeagueStatuses().finished).toEqual([]);
    setClock(KR_CLOSE + 30 * MIN);
    expect(updateLeagueStatuses().finished).toEqual([leagueId]);
  });
});

describe('cancelLockedUntil', () => {
  it('locks an order placed during the session until its print can have arrived', () => {
    const placed = KR_OPEN + HOUR;
    expect(cancelLockedUntil('KR', placed, placed)).toBe(placed + LAG);
    expect(cancelLockedUntil('KR', placed, placed + LAG - 1)).toBe(placed + LAG);
    expect(cancelLockedUntil('KR', placed, placed + LAG)).toBeNull();
  });

  it('leaves an order placed before the open free until the open, then counts from the open', () => {
    const placed = KR_OPEN - HOUR;
    expect(cancelLockedUntil('KR', placed, KR_OPEN - 1)).toBeNull();
    expect(cancelLockedUntil('KR', placed, KR_OPEN)).toBe(KR_OPEN + LAG);
  });

  it('locks an order placed near the close until the closing print can have arrived', () => {
    const placed = KR_CLOSE - 5 * MIN;
    expect(cancelLockedUntil('KR', placed, KR_CLOSE + 10 * MIN)).toBe(KR_CLOSE + LAG);
    expect(cancelLockedUntil('KR', placed, KR_CLOSE + LAG)).toBeNull();
  });

  it('locks a resting order only once the session has closed, until the closing print can have arrived', () => {
    const placed = KR_OPEN + HOUR;
    expect(cancelLockedUntil('KR', placed, KR_CLOSE - HOUR)).toBeNull();
    expect(cancelLockedUntil('KR', placed, KR_CLOSE)).toBeNull();
    expect(cancelLockedUntil('KR', placed, KR_CLOSE + 1)).toBe(KR_CLOSE + LAG);
    expect(cancelLockedUntil('KR', placed, KR_CLOSE + LAG)).toBeNull();
  });

  it('never locks an order placed after the close, a US order, or a live KR source', () => {
    expect(cancelLockedUntil('KR', KR_CLOSE + MIN, KR_CLOSE + 2 * MIN)).toBeNull();
    expect(cancelLockedUntil('US', KR_OPEN + HOUR, KR_OPEN + HOUR)).toBeNull();
    Object.assign(config, { priceProvider: 'kis_kr', kisAppKey: 'k', kisAppSecret: 's' });
    expect(cancelLockedUntil('KR', KR_OPEN + HOUR, KR_OPEN + HOUR)).toBeNull();
  });
});

describe('cancelOrder with delayed quotes', () => {
  it('refuses inside the lock and allows it afterwards', () => {
    const { participantId } = activeLeague('KR', { duration_days: 3 });
    feed(quote(SAMSUNG, 70_000));
    const order = buy(participantId, SAMSUNG, 1);

    setClock(clockNow() + 5 * MIN);
    let error: unknown;
    try {
      cancelOrder(order.id, participantId);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('cancel_locked');
    expect((error as EngineError).message).toContain('17분 뒤');

    setClock(order.created_at + LAG);
    expect(cancelOrder(order.id, participantId).status).toBe('canceled');
  });
});

describe('isStale with delayed quotes', () => {
  it('allows for the source delay', () => {
    const at = KR_OPEN + HOUR;
    expect(isStale(quote(SAMSUNG, 1, at - 21 * MIN), at)).toBe(false);
    expect(isStale(quote(SAMSUNG, 1, at - 25 * MIN), at)).toBe(false);
    expect(isStale(quote(SAMSUNG, 1, at - 25 * MIN - 1), at)).toBe(true);
  });

  it('does not flag yesterday\'s close before the first print of the day can have arrived', () => {
    const yesterday = KR_OPEN - 18 * HOUR;
    expect(isStale(quote(SAMSUNG, 1, yesterday), KR_OPEN + 25 * MIN)).toBe(false);
    expect(isStale(quote(SAMSUNG, 1, yesterday), KR_OPEN + 25 * MIN + 1)).toBe(true);
  });
});

describe('marketStatus with delayed quotes', () => {
  it('says how late KR prices are', () => {
    expect(marketStatus('KR').note).toContain('약 20분 지연');
    expect(marketStatus('US').note).not.toContain('지연');
  });

  it('reports each market\'s own source with kis_kr', () => {
    Object.assign(config, { priceProvider: 'kis_kr', kisAppKey: 'k', kisAppSecret: 's' });
    expect(marketStatus('KR').provider).toBe('kis');
    expect(marketStatus('KR').note).toContain('한국투자증권');
    expect(marketStatus('US').provider).toBe('yahoo');
  });
});

describe('krAuctionPending', () => {
  it('covers the first minute and the closing auction through a minute after the close', () => {
    expect(krAuctionPending(KR_OPEN - 1)).toBe(false);
    expect(krAuctionPending(KR_OPEN)).toBe(true);
    expect(krAuctionPending(KR_OPEN + MIN)).toBe(false);
    expect(krAuctionPending(KR_CLOSE - 10 * MIN - 1)).toBe(false);
    expect(krAuctionPending(KR_CLOSE - 10 * MIN)).toBe(true);
    expect(krAuctionPending(KR_CLOSE + MIN - 1)).toBe(true);
    expect(krAuctionPending(KR_CLOSE + MIN)).toBe(false);
  });
});

describe('krFromKis', () => {
  const kr = SYMBOLS.find((s) => s.market === 'KR')!;
  const us = SYMBOLS.find((s) => s.market === 'US')!;
  const provider = (name: 'kis' | 'yahoo', fetchQuotes: PriceProvider['fetchQuotes']): PriceProvider => ({
    name,
    fetchQuotes,
    fetchDailyBars: async () => [],
  });
  const stamp = (source: 'kis' | 'yahoo') => async (symbols: typeof SYMBOLS) =>
    symbols.map((s) => ({ symbol: s.symbol, market: s.market, price: 1, change_pct: 0, volume: 0, ts: 1, source }));

  it('sends KR symbols to KIS and the rest to the other provider', async () => {
    const quotes = await krFromKis(provider('kis', stamp('kis')), provider('yahoo', stamp('yahoo'))).fetchQuotes([kr, us]);
    expect(quotes.map((q) => [q.symbol, q.source])).toEqual([
      [kr.symbol, 'kis'],
      [us.symbol, 'yahoo'],
    ]);
  });

  it('keeps the other market when one source fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = provider('kis', async () => {
      throw new Error('boom');
    });
    const quotes = await krFromKis(failing, provider('yahoo', stamp('yahoo'))).fetchQuotes([kr, us]);
    expect(quotes.map((q) => q.symbol)).toEqual([us.symbol]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(getQuote(us.symbol)).toBeUndefined(); // the provider only fetches; the collector caches
  });
});
