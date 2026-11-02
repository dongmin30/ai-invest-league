import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Order } from '../../../shared/api-types';
import { db } from '../../src/db/db';
import { matchOrders } from '../../src/engine/matcher';
import { getLeagueRow, getOrderRow } from '../../src/engine/store';
import { availableCash, equityOf, getPortfolio } from '../../src/engine/portfolio';
import { bus } from '../../src/lib/bus';
import { POST_CLOSE_FETCH_MS } from '../../src/market/calendar';
import {
  HOUR,
  KR_CLOSE,
  KR_OPEN,
  MIN,
  US_OPEN,
  activeLeague,
  buy,
  cashOf,
  clockNow,
  feed,
  quote,
  resetEngineState,
  restoreEngineState,
  sell,
  setClock,
} from './helpers';

const SAMSUNG = '005930';

function holding(participantId: number, symbol: string) {
  return db.prepare('SELECT quantity, avg_price FROM holdings WHERE participant_id = ? AND symbol = ?').get(participantId, symbol);
}

/** Advances the clock one minute and matches against a quote stamped with the new time. */
function tick(symbol: string, price: number): Order[] {
  setClock(clockNow() + MIN);
  return matchOrders(feed(quote(symbol, price)));
}

describe('matchOrders: fill timing (rule 1)', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('fills a market order only at a quote newer than the order', () => {
    const { participantId } = activeLeague();
    const placedAt = clockNow();
    feed(quote(SAMSUNG, 70_000, placedAt - MIN));
    const order = buy(participantId, SAMSUNG, 10);

    expect(matchOrders([quote(SAMSUNG, 70_000, placedAt - MIN)])).toEqual([]);
    expect(matchOrders([quote(SAMSUNG, 70_000, placedAt)])).toEqual([]);
    expect(getOrderRow(order.id)!.status).toBe('pending');

    const filled = matchOrders([quote(SAMSUNG, 71_000, placedAt + 1)]);
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ id: order.id, status: 'filled', fill_price: 71_000, filled_at: placedAt + 1 });
  });

  it('does not fill at quotes stamped while the market is closed', () => {
    const { participantId } = activeLeague();
    setClock(KR_CLOSE + HOUR); // Monday 16:30 KST
    feed(quote(SAMSUNG, 70_000, KR_CLOSE));
    const order = buy(participantId, SAMSUNG, 10);

    expect(matchOrders([quote(SAMSUNG, 69_000, KR_CLOSE + 2 * HOUR)])).toEqual([]);
    expect(getOrderRow(order.id)!.status).toBe('pending');

    // Tuesday 09:01 KST
    const nextMorning = KR_OPEN + 24 * HOUR + MIN;
    setClock(nextMorning);
    const filled = matchOrders([quote(SAMSUNG, 69_500, nextMorning)]);
    expect(filled.map((o) => [o.id, o.status, o.fill_price])).toEqual([[order.id, 'filled', 69_500]]);
  });

  it('honors SIM_ALWAYS_OPEN for night demos', async () => {
    const { config } = await import('../../src/config');
    const { participantId } = activeLeague();
    setClock(KR_CLOSE + 5 * HOUR);
    feed(quote(SAMSUNG, 70_000, KR_CLOSE));
    buy(participantId, SAMSUNG, 1);
    config.simAlwaysOpen = true;
    expect(tick(SAMSUNG, 70_000)).toHaveLength(1);
  });

  it('uses the latest quote per symbol and ignores other markets', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    const order = buy(participantId, SAMSUNG, 1);
    const t = clockNow();
    const filled = matchOrders([quote(SAMSUNG, 70_500, t + 2), quote(SAMSUNG, 70_100, t + 1), quote('AAPL', 190, t + 1)]);
    expect(filled.map((o) => [o.id, o.fill_price])).toEqual([[order.id, 70_500]]);
  });

  it('emits an order event per fill', () => {
    const { leagueId, participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    buy(participantId, SAMSUNG, 1);
    const seen: { league_id: number; order: Order }[] = [];
    const listener = (e: { league_id: number; order: Order }) => seen.push(e);
    bus.on('order', listener);
    try {
      tick(SAMSUNG, 70_000);
    } finally {
      bus.off('order', listener);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ league_id: leagueId, order: { status: 'filled' } });
  });
});

describe('matchOrders: cash, holdings and fees (rule 2)', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('KR: fee on both sides, tax on SELL only, weighted average price', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));

    buy(participantId, SAMSUNG, 10);
    const [first] = tick(SAMSUNG, 70_000);
    expect(first).toMatchObject({ fill_price: 70_000, fee: 105, tax: 0 });
    expect(cashOf(participantId)).toBe(9_299_895);
    expect(holding(participantId, SAMSUNG)).toEqual({ quantity: 10, avg_price: 70_000 });

    buy(participantId, SAMSUNG, 10);
    tick(SAMSUNG, 72_000);
    expect(cashOf(participantId)).toBe(9_299_895 - 720_108);
    expect(holding(participantId, SAMSUNG)).toEqual({ quantity: 20, avg_price: 71_000 });

    sell(participantId, SAMSUNG, 5);
    const [sold] = tick(SAMSUNG, 75_000);
    // 375,000 − fee 56 (56.25) − tax 750
    expect(sold).toMatchObject({ side: 'SELL', fill_price: 75_000, fee: 56, tax: 750 });
    expect(cashOf(participantId)).toBe(8_579_787 + 374_194);
    expect(holding(participantId, SAMSUNG)).toEqual({ quantity: 15, avg_price: 71_000 });

    const portfolio = getPortfolio(participantId);
    expect(portfolio.holdings[0]).toMatchObject({
      symbol: SAMSUNG,
      name: '삼성전자',
      quantity: 15,
      price: 75_000,
      value: 1_125_000,
      pnl: 60_000,
    });
    expect(portfolio.equity).toBe(8_953_981 + 1_125_000);
    expect(portfolio.return_rate).toBeCloseTo(10_078_981 / 10_000_000 - 1, 12);

    sell(participantId, SAMSUNG, 15);
    tick(SAMSUNG, 70_000);
    expect(holding(participantId, SAMSUNG)).toBeUndefined();
    // 1,050,000 − fee 158 (157.5) − tax 2,100
    expect(cashOf(participantId)).toBe(8_953_981 + 1_047_742);
    expect(equityOf(participantId)).toBe(cashOf(participantId));
  });

  it('KR ETF: sells pay the fee but no securities transaction tax', () => {
    const { participantId } = activeLeague();
    const KODEX200 = '069500';
    feed(quote(KODEX200, 90_000));
    buy(participantId, KODEX200, 10);
    tick(KODEX200, 90_000);
    // 900,000 + fee 135
    expect(cashOf(participantId)).toBe(10_000_000 - 900_135);
    sell(participantId, KODEX200, 10);
    const [sold] = tick(KODEX200, 100_000);
    // 1,000,000 − fee 150 − tax 0 (a stock would also pay 2,000)
    expect(sold).toMatchObject({ side: 'SELL', fill_price: 100_000, fee: 150, tax: 0 });
    expect(cashOf(participantId)).toBe(10_000_000 - 900_135 + 999_850);
  });

  it('US: cents rounding and no tax', () => {
    setClock(US_OPEN + HOUR);
    const { participantId } = activeLeague('US');
    feed(quote('AAPL', 189.37));
    buy(participantId, 'AAPL', 3);
    tick('AAPL', 189.37);
    expect(cashOf(participantId)).toBe(9_431.32);
    sell(participantId, 'AAPL', 3);
    const [sold] = tick('AAPL', 200.01);
    expect(sold).toMatchObject({ fee: 0.6, tax: 0 });
    expect(cashOf(participantId)).toBe(10_030.75);
  });

  it('fills LIMIT orders only when the price crosses, at the quote price', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    const limitBuy = buy(participantId, SAMSUNG, 10, 69_000);
    expect(tick(SAMSUNG, 69_100)).toEqual([]);
    expect(tick(SAMSUNG, 68_500)).toMatchObject([{ id: limitBuy.id, status: 'filled', fill_price: 68_500 }]);

    const limitSell = sell(participantId, SAMSUNG, 10, 72_000);
    expect(tick(SAMSUNG, 71_900)).toEqual([]);
    expect(tick(SAMSUNG, 72_000)).toMatchObject([{ id: limitSell.id, status: 'filled', fill_price: 72_000 }]);
  });

  it('re-checks cash and shares at fill time and rejects with a reason', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    const pendingBuy = buy(participantId, SAMSUNG, 10);
    db.prepare('UPDATE participants SET cash = 100000 WHERE id = ?').run(participantId);
    const [rejected] = tick(SAMSUNG, 70_000);
    expect(rejected).toMatchObject({ id: pendingBuy.id, status: 'rejected' });
    expect(rejected!.reject_reason).toBeTruthy();
    expect(cashOf(participantId)).toBe(100_000);

    db.prepare('INSERT INTO holdings (participant_id, symbol, quantity, avg_price) VALUES (?, ?, 5, 70000)').run(
      participantId,
      SAMSUNG,
    );
    const pendingSell = sell(participantId, SAMSUNG, 5);
    db.prepare('UPDATE holdings SET quantity = 2 WHERE participant_id = ?').run(participantId);
    expect(tick(SAMSUNG, 70_000)).toMatchObject([{ id: pendingSell.id, status: 'rejected' }]);
    expect(holding(participantId, SAMSUNG)).toEqual({ quantity: 2, avg_price: 70_000 });
  });

  it('a filled BUY does not double-count its own reservation, and later buys see the spent cash', () => {
    const { participantId } = activeLeague('KR', { start_cash: 1_400_210 });
    db.prepare('UPDATE leagues SET max_position_pct = 1').run();
    feed(quote(SAMSUNG, 70_000));
    buy(participantId, SAMSUNG, 10);
    buy(participantId, SAMSUNG, 10);
    // Both reservations (700,105 each) use all the cash and both fill at the reserved price.
    expect(tick(SAMSUNG, 70_000).map((o) => o.status)).toEqual(['filled', 'filled']);
    expect(cashOf(participantId)).toBe(0);
    expect(availableCash(participantId)).toBe(0);
  });
});

describe('matchOrders: cash reserved by other pending BUYs (rule 3)', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  const HYNIX = '000660';

  it('rejects a fill that would spend cash reserved for another pending BUY', () => {
    const { participantId } = activeLeague('KR');
    db.prepare('UPDATE leagues SET max_position_pct = 1').run();
    feed(quote(SAMSUNG, 100_000), quote(HYNIX, 100_000));
    const limit = buy(participantId, HYNIX, 50, 90_000); // reserves 4,500,675
    const market = buy(participantId, SAMSUNG, 54); // reserved at 100,000: 5,400,810
    expect(availableCash(participantId)).toBe(10_000_000 - 4_500_675 - 5_400_810);

    // A gap to 180,000 would cost 9,721,458: more than the 5,499,325 not held for the LIMIT order.
    const [rejected] = tick(SAMSUNG, 180_000);
    expect(rejected).toMatchObject({ id: market.id, status: 'rejected' });
    expect(cashOf(participantId)).toBe(10_000_000);
    expect(availableCash(participantId)).toBe(10_000_000 - 4_500_675);
    expect(getOrderRow(limit.id)!.status).toBe('pending');

    // The LIMIT order keeps its reservation and still fills when it crosses.
    expect(tick(HYNIX, 89_000)).toMatchObject([{ id: limit.id, status: 'filled', fill_price: 89_000 }]);
    expect(availableCash(participantId)).toBeGreaterThanOrEqual(0);
  });

  it('lets a fill above its own reservation use cash that no other order holds', () => {
    const { participantId } = activeLeague('KR');
    db.prepare('UPDATE leagues SET max_position_pct = 1').run();
    feed(quote(SAMSUNG, 100_000), quote(HYNIX, 100_000));
    buy(participantId, HYNIX, 50, 90_000);
    const market = buy(participantId, SAMSUNG, 10);
    expect(tick(SAMSUNG, 150_000)).toMatchObject([{ id: market.id, status: 'filled', fill_price: 150_000 }]);
    expect(cashOf(participantId)).toBe(10_000_000 - 1_500_225);
    expect(availableCash(participantId)).toBe(10_000_000 - 1_500_225 - 4_500_675);
  });

  it('fills a USD BUY that costs exactly the free cash (no float-error reject)', () => {
    setClock(US_OPEN + HOUR);
    const { participantId } = activeLeague('US', { start_at: US_OPEN });
    db.prepare('UPDATE participants SET cash = 1000 WHERE id = ?').run(participantId);
    db.prepare("INSERT INTO holdings (participant_id, symbol, quantity, avg_price) VALUES (?, 'MSFT', 20, 450)").run(participantId);
    feed(quote('MSFT', 450), quote('AAPL', 101), quote('NVDA', 898.92));
    const limit = buy(participantId, 'AAPL', 1, 100.08); // reserves 100.08 + 0.10 = 100.18
    expect(availableCash(participantId)).toBe(899.82);
    const market = buy(participantId, 'NVDA', 1); // 898.92 + 0.90 = 899.82, exactly what is left
    setClock(US_OPEN + HOUR + MIN);
    // 1000 − 100.18 is 899.8199999999999 in floating point; the fill compares rounded cents.
    expect(matchOrders(feed(quote('NVDA', 898.92)))).toMatchObject([{ id: market.id, status: 'filled', fill_price: 898.92 }]);
    expect(cashOf(participantId)).toBe(100.18);
    expect(availableCash(participantId)).toBe(0);
    expect(getOrderRow(limit.id)!.status).toBe('pending');
  });
});

describe('matchOrders: league end', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('never fills at quotes stamped after the league end_at, even while it is still active', () => {
    const { leagueId, participantId } = activeLeague('KR', { duration_days: 1 });
    expect(getLeagueRow(leagueId)!.end_at).toBe(KR_CLOSE);
    feed(quote(SAMSUNG, 100_000));
    const order = buy(participantId, SAMSUNG, 10, 90_000);

    // Server down across end_at: the next trading day's quote arrives before updateLeagueStatuses().
    const nextMorning = KR_OPEN + 24 * HOUR + 5 * MIN;
    setClock(nextMorning);
    expect(getLeagueRow(leagueId)!.status).toBe('active');
    expect(matchOrders([quote(SAMSUNG, 85_000, nextMorning)])).toEqual([]);
    expect(getOrderRow(order.id)!.status).toBe('pending');
    expect(cashOf(participantId)).toBe(10_000_000);

    // A quote stamped at or before end_at is still usable.
    expect(matchOrders([quote(SAMSUNG, 89_000, KR_CLOSE - MIN)])).toMatchObject([{ id: order.id, status: 'filled' }]);
  });
});

describe('matchOrders: closing print stamped just after the close', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  // Yahoo stamps the KRX closing auction print about 5 s after 15:30:00 KST.
  const CLOSING_PRINT = KR_CLOSE + 5_000;

  it('fills an order placed in the closing auction at the closing print, but not one placed after the close', () => {
    const { participantId } = activeLeague('KR'); // ends days later
    setClock(KR_CLOSE - 5 * MIN); // 15:25, closing call auction: no prints until the close
    feed(quote(SAMSUNG, 70_000, KR_CLOSE - 10 * MIN));
    const auction = buy(participantId, SAMSUNG, 10);
    setClock(KR_CLOSE + 2_000); // placed after the close, before the closing print arrives
    const afterClose = buy(participantId, SAMSUNG, 1);

    setClock(KR_CLOSE + 30_000);
    expect(matchOrders([quote(SAMSUNG, 71_000, CLOSING_PRINT)])).toMatchObject([
      { id: auction.id, status: 'filled', fill_price: 71_000, filled_at: CLOSING_PRINT },
    ]);
    expect(getOrderRow(afterClose.id)!.status).toBe('pending');

    // Past the post-close window a quote is no longer the closing print.
    expect(matchOrders([quote(SAMSUNG, 71_000, KR_CLOSE + POST_CLOSE_FETCH_MS + 1)])).toEqual([]);
    expect(getOrderRow(afterClose.id)!.status).toBe('pending');
  });

  it('keeps ts > created_at for the closing print', () => {
    const { participantId } = activeLeague('KR');
    setClock(KR_CLOSE);
    feed(quote(SAMSUNG, 70_000, KR_CLOSE - MIN));
    const order = buy(participantId, SAMSUNG, 1);
    expect(matchOrders([quote(SAMSUNG, 71_000, KR_CLOSE)])).toEqual([]);
    expect(matchOrders([quote(SAMSUNG, 71_000, KR_CLOSE + 1)])).toMatchObject([{ id: order.id, status: 'filled' }]);
  });

  it("on a league's last day fills at the closing print stamped after end_at, only for orders placed by end_at", () => {
    const { leagueId, participantId } = activeLeague('KR', { duration_days: 1 });
    expect(getLeagueRow(leagueId)!.end_at).toBe(KR_CLOSE);
    db.prepare('INSERT INTO holdings (participant_id, symbol, quantity, avg_price) VALUES (?, ?, 10, 70000)').run(
      participantId,
      SAMSUNG,
    );
    setClock(KR_CLOSE - 5 * MIN);
    feed(quote(SAMSUNG, 70_000, KR_CLOSE - 10 * MIN));
    const sold = sell(participantId, SAMSUNG, 5);
    const late = sell(participantId, SAMSUNG, 5);
    // A pending order stamped after end_at (the league is still 'active' until the status update).
    db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(KR_CLOSE + 1_000, late.id);

    setClock(KR_CLOSE + 30_000);
    expect(matchOrders([quote(SAMSUNG, 72_000, CLOSING_PRINT)])).toMatchObject([
      { id: sold.id, status: 'filled', fill_price: 72_000 },
    ]);
    expect(getOrderRow(late.id)!.status).toBe('pending');
    // Beyond end_at + POST_CLOSE_FETCH_MS nothing fills.
    expect(matchOrders([quote(SAMSUNG, 72_000, KR_CLOSE + POST_CLOSE_FETCH_MS + 1)])).toEqual([]);
  });
});
