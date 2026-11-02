import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Order } from '../../../shared/api-types';
import { db } from '../../src/db/db';
import { createLeague } from '../../src/engine/leagues';
import { matchOrders } from '../../src/engine/matcher';
import { EngineError, cancelOrder, listOrders, placeOrder } from '../../src/engine/orders';
import { availableCash, getPortfolio } from '../../src/engine/portfolio';
import { bus } from '../../src/lib/bus';
import {
  HOUR,
  KR_OPEN,
  MIN,
  activeLeague,
  buy,
  clockNow,
  feed,
  makeUser,
  quote,
  resetEngineState,
  restoreEngineState,
  sell,
  setClock,
} from './helpers';

const SAMSUNG = '005930';
const HYNIX = '000660';
const LGES = '373220';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe(code);
    expect((err as EngineError).message).not.toBe('');
    return;
  }
  throw new Error(`expected EngineError '${code}'`);
}

/** Fills everything pending on `symbol` at `price` with a quote one minute later. */
function fillAt(symbol: string, price: number): Order[] {
  setClock(clockNow() + MIN);
  return matchOrders(feed(quote(symbol, price)));
}

describe('placeOrder validation', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('records a pending order with the quote as ref price and the market-local trade date', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    const order = buy(participantId, SAMSUNG, 10);
    expect(order).toMatchObject({ status: 'pending', side: 'BUY', type: 'MARKET', quantity: 10, source: 'user' });
    expect(order.created_at).toBe(clockNow());
    const row = db.prepare('SELECT ref_price, trade_date FROM orders WHERE id = ?').get(order.id);
    expect(row).toEqual({ ref_price: 70_000, trade_date: '2026-10-19' });
  });

  it('rejects orders outside an active league', () => {
    const ownerId = makeUser();
    const upcoming = createLeague({
      name: '예정 리그',
      market: 'KR',
      type: 'custom',
      duration_days: 3,
      is_public: true,
      owner_id: ownerId,
      start_at: KR_OPEN + 24 * HOUR,
    });
    feed(quote(SAMSUNG, 70_000));
    expectCode(() => buy(upcoming.my_participant_id!, SAMSUNG, 1), 'league_inactive');
    expectCode(() => buy(9999, SAMSUNG, 1), 'not_found');
  });

  it('accepts orders while the market is closed and keeps them pending', () => {
    const { participantId } = activeLeague();
    setClock(KR_OPEN + 10 * HOUR);
    feed(quote(SAMSUNG, 70_000, KR_OPEN + 6 * HOUR));
    expect(buy(participantId, SAMSUNG, 1).status).toBe('pending');
  });

  it('validates symbol, quantity, limit price and quote availability', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000), quote('AAPL', 190));
    expectCode(() => buy(participantId, 'AAPL', 1), 'bad_symbol');
    expectCode(() => buy(participantId, 'NOPE', 1), 'bad_symbol');
    expectCode(() => buy(participantId, SAMSUNG, 0), 'bad_quantity');
    expectCode(() => buy(participantId, SAMSUNG, 1.5), 'bad_quantity');
    expectCode(() => buy(participantId, SAMSUNG, -3), 'bad_quantity');
    expectCode(() => placeOrder(participantId, { symbol: SAMSUNG, side: 'BUY', type: 'LIMIT', quantity: 1 }, 'user'), 'bad_limit');
    expectCode(() => buy(participantId, SAMSUNG, 1, 0), 'bad_limit');
    expectCode(() => buy(participantId, HYNIX, 1), 'no_quote');
  });

  it('emits an order event on placement', () => {
    const { leagueId, participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    const seen: unknown[] = [];
    const listener = (e: unknown) => seen.push(e);
    bus.on('order', listener);
    try {
      const order = buy(participantId, SAMSUNG, 1);
      expect(seen).toEqual([{ league_id: leagueId, participant_id: participantId, order }]);
    } finally {
      bus.off('order', listener);
    }
  });
});

describe('cash reservation', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('reserves amount + fee for pending BUY orders and releases it on cancel', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    const order = buy(participantId, SAMSUNG, 10);
    expect(availableCash(participantId)).toBe(10_000_000 - 700_105);
    expect(getPortfolio(participantId)).toMatchObject({ cash: 10_000_000, available_cash: 9_299_895 });

    cancelOrder(order.id, participantId);
    expect(availableCash(participantId)).toBe(10_000_000);
  });

  it('reserves at the limit price for LIMIT buys', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    buy(participantId, SAMSUNG, 10, 60_000);
    expect(availableCash(participantId)).toBe(10_000_000 - 600_090);
  });

  it('rejects a BUY that exceeds available cash including fees and earlier reservations', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000), quote(HYNIX, 100_000), quote(LGES, 100_000));
    buy(participantId, SAMSUNG, 57); // 3,990,598.5 → 3,990,599 reserved
    buy(participantId, HYNIX, 39); // 3,900,585 reserved
    // 2,108,816 left: 21 × 100,000 + fee 315 = 2,100,315 fits, 22 does not
    expectCode(() => buy(participantId, LGES, 22), 'insufficient_cash');
    expect(buy(participantId, LGES, 21).status).toBe('pending');
  });

  it('counts the fee when checking cash', () => {
    const { leagueId, participantId } = activeLeague('KR', { start_cash: 700_104 });
    db.prepare('UPDATE leagues SET max_position_pct = 1 WHERE id = ?').run(leagueId);
    feed(quote(SAMSUNG, 70_000));
    // 10 × 70,000 = 700,000 fits the cash, but not with the 105 won fee.
    expectCode(() => buy(participantId, SAMSUNG, 10), 'insufficient_cash');
    db.prepare('UPDATE participants SET cash = 700105 WHERE id = ?').run(participantId);
    expect(buy(participantId, SAMSUNG, 10).status).toBe('pending');
    expect(availableCash(participantId)).toBe(0);
  });
});

describe('daily limit', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('counts every non-rejected order of the market-local day', () => {
    const { participantId } = activeLeague(); // custom: 10 orders per day
    feed(quote(SAMSUNG, 70_000));
    const orders = Array.from({ length: 10 }, () => buy(participantId, SAMSUNG, 1));
    cancelOrder(orders[0]!.id, participantId);
    expectCode(() => buy(participantId, SAMSUNG, 1), 'daily_limit');
    expect(getPortfolio(participantId).orders_today).toBe(10);

    db.prepare("UPDATE orders SET status = 'rejected' WHERE id = ?").run(orders[1]!.id);
    expect(buy(participantId, SAMSUNG, 1).status).toBe('pending');
    expectCode(() => buy(participantId, SAMSUNG, 1), 'daily_limit');
  });

  it('resets on the next market-local date', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    for (let i = 0; i < 10; i++) buy(participantId, SAMSUNG, 1);
    // 23:59 KST on Monday is still the same trade date.
    setClock(KR_OPEN + 14 * HOUR + 59 * MIN);
    expectCode(() => buy(participantId, SAMSUNG, 1), 'daily_limit');
    // 00:00 KST Tuesday is a new one.
    setClock(KR_OPEN + 15 * HOUR);
    expect(buy(participantId, SAMSUNG, 1).status).toBe('pending');
    expect(getPortfolio(participantId).orders_today).toBe(1);
  });
});

describe('position cap', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('rejects a BUY that would push one symbol above 40% of equity, counting holdings and pending buys', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    // cap = 4,000,000: 57 × 70,000 = 3,990,000 fits, 58 does not
    expectCode(() => buy(participantId, SAMSUNG, 58), 'position_cap');
    buy(participantId, SAMSUNG, 30);
    expectCode(() => buy(participantId, SAMSUNG, 28), 'position_cap');
    buy(participantId, SAMSUNG, 27);
    fillAt(SAMSUNG, 70_000);
    expectCode(() => buy(participantId, SAMSUNG, 1), 'position_cap');
  });
});

describe('insufficient shares', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('rejects SELL beyond holdings minus pending sells', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    expectCode(() => sell(participantId, SAMSUNG, 1), 'insufficient_shares');
    buy(participantId, SAMSUNG, 10);
    expectCode(() => sell(participantId, SAMSUNG, 1), 'insufficient_shares'); // the buy is not filled yet
    fillAt(SAMSUNG, 70_000);

    const pendingSell = sell(participantId, SAMSUNG, 6, 90_000);
    expectCode(() => sell(participantId, SAMSUNG, 5), 'insufficient_shares');
    expect(sell(participantId, SAMSUNG, 4).status).toBe('pending');
    expectCode(() => sell(participantId, SAMSUNG, 1), 'insufficient_shares');

    cancelOrder(pendingSell.id, participantId);
    expect(sell(participantId, SAMSUNG, 6).status).toBe('pending');
  });
});

describe('cancelOrder', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('cancels only pending orders of the given participant', () => {
    const { participantId } = activeLeague();
    const other = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    const order = buy(participantId, SAMSUNG, 1);

    expectCode(() => cancelOrder(order.id, other.participantId), 'not_found');
    expectCode(() => cancelOrder(424242, participantId), 'not_found');
    expect(cancelOrder(order.id, participantId).status).toBe('canceled');
    expectCode(() => cancelOrder(order.id, participantId), 'not_pending');

    const filled = buy(participantId, SAMSUNG, 1);
    fillAt(SAMSUNG, 70_000);
    expectCode(() => cancelOrder(filled.id, participantId), 'not_pending');
  });

  it('lists orders newest first with an optional status filter', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 70_000));
    const first = buy(participantId, SAMSUNG, 1);
    setClock(clockNow() + 1000);
    const second = buy(participantId, SAMSUNG, 2);
    cancelOrder(first.id, participantId);
    expect(listOrders(participantId).map((o) => o.id)).toEqual([second.id, first.id]);
    expect(listOrders(participantId, 'canceled').map((o) => o.id)).toEqual([first.id]);
  });
});
