import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { updateLeagueStatuses } from '../../src/engine/leagues';
import { matchOrders } from '../../src/engine/matcher';
import { createCollector } from '../../src/market/collector';
import type { PriceProvider, ProviderQuote } from '../../src/market/providers/types';
import { clearQuotes, getQuote } from '../../src/market/quoteCache';
import { HOUR, MIN, US_OPEN, activeLeague, buy, clockNow, feed, quote, resetEngineState, restoreEngineState, setClock } from './helpers';

const APPLE = 'AAPL';
const US_CLOSE = US_OPEN + 6.5 * HOUR;
const OFFICIAL_CLOSE = 210;
const AFTER_MARKET = 300;

/** Every symbol trades after hours at AFTER_MARKET, with OFFICIAL_CLOSE as its regular print. */
const afterMarketProvider: PriceProvider = {
  name: 'yahoo',
  fetchQuotes: async (symbols) =>
    symbols.map(
      (s): ProviderQuote => ({
        symbol: s.symbol,
        market: s.market,
        price: AFTER_MARKET,
        change_pct: 40,
        volume: 0,
        ts: clockNow() - MIN,
        source: 'yahoo',
        regular: { price: OFFICIAL_CLOSE, change_pct: 5, ts: US_CLOSE + 1000 },
      }),
    ),
  fetchDailyBars: async () => [],
};

const finalReturn = (participantId: number) =>
  db.prepare('SELECT final_return FROM participants WHERE id = ?').pluck().get(participantId) as number;

describe('a US league that ended while the server was off', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  function holdingLeague() {
    setClock(US_OPEN + HOUR);
    const { leagueId, participantId } = activeLeague('US', { duration_days: 1 });
    feed(quote(APPLE, 200));
    buy(participantId, APPLE, 1);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(APPLE, 200)));
    clearQuotes(); // a fresh process has no cached quotes
    return { leagueId, participantId };
  }

  it('settles on the official close, not an after-market trade', async () => {
    const { leagueId, participantId } = holdingLeague();
    setClock(US_CLOSE + 2 * HOUR);
    const collector = createCollector(afterMarketProvider);

    await collector.tick();
    expect(getQuote(APPLE)).toMatchObject({ price: OFFICIAL_CLOSE, ts: US_CLOSE + 1000 });
    expect(getQuote(APPLE)).not.toHaveProperty('regular');

    expect(updateLeagueStatuses().finished).toEqual([leagueId]);
    // 10,000 − 200 − fee 0.2 + 210; at the after-market price it would be about +1%.
    expect(finalReturn(participantId)).toBeCloseTo(0.00098, 4);

    // Once the league has finished, quotes follow the after-market again.
    setClock(clockNow() + MIN);
    await collector.tick();
    expect(getQuote(APPLE)).toMatchObject({ price: AFTER_MARKET });
    expect(getQuote(APPLE)).not.toHaveProperty('regular');
  });

  it('keeps after-market prices while no league is waiting on the close', async () => {
    setClock(US_OPEN + HOUR);
    activeLeague('US', { duration_days: 5 });
    setClock(US_CLOSE + 2 * HOUR);
    await createCollector(afterMarketProvider).tick();
    expect(getQuote(APPLE)).toMatchObject({ price: AFTER_MARKET });
  });
});
