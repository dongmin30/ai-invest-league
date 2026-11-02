import { describe, expect, it } from 'vitest';
import type { Order } from '../../../shared/api-types';
import { DecisionSchema } from '../../src/agents/schema';
import { decideBaseline } from '../../src/agents/strategies/baseline';
import { decideMomentum } from '../../src/agents/strategies/momentum';
import type { DecisionInput } from '../../src/agents/types';
import { candidate, holding, pureInput } from './fixtures';

const FEE = 0.00015;

/** Pool of 12 candidates; c00 has the largest volume. */
const pool = Array.from({ length: 12 }, (_, i) =>
  candidate(`c${String(i).padStart(2, '0')}`, 10_000 + i * 1_000, { volume: (20 - i) * 1_000 }),
);

function spent(input: DecisionInput, orders: { symbol: string; side: string; quantity: number }[]): number {
  const price = new Map(input.candidates.map((c) => [c.symbol, c.price!]));
  return orders.filter((o) => o.side === 'BUY').reduce((s, o) => s + o.quantity * price.get(o.symbol)! * (1 + FEE), 0);
}

function pendingBuy(symbol: string, quantity: number): Order {
  return {
    id: 1,
    participant_id: 1,
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quantity,
    limit_price: null,
    status: 'pending',
    reject_reason: null,
    fill_price: null,
    fee: null,
    tax: null,
    fx_rate: null,
    created_at: 0,
    filled_at: null,
    source: 'agent',
  };
}

describe('baseline strategy', () => {
  it('buys the 10 largest-volume candidates with equal weight over two decisions of at most 5 orders', () => {
    const input = pureInput({ candidates: pool, maxOrders: 20 });
    const first = decideBaseline(input);
    expect(first.orders.map((o) => o.symbol)).toEqual(pool.slice(0, 5).map((c) => c.symbol));
    expect(DecisionSchema.safeParse(first).success).toBe(true);

    const holdings = first.orders.map((o) => holding(o.symbol, o.quantity, pool.find((c) => c.symbol === o.symbol)!.price!));
    const invested = spent(input, first.orders);
    const second = decideBaseline(pureInput({ cash: 10_000_000 - invested, holdings, candidates: pool, maxOrders: 20 }));
    expect(second.orders.map((o) => o.symbol)).toEqual(pool.slice(5, 10).map((c) => c.symbol));

    const orders = [...first.orders, ...second.orders];
    for (const o of orders) {
      expect(o.side).toBe('BUY');
      expect(Number.isInteger(o.quantity)).toBe(true);
      const price = pool.find((c) => c.symbol === o.symbol)!.price!;
      const value = o.quantity * price;
      expect(value).toBeLessThanOrEqual(950_000);
      // The second decision sizes from equity after the first batch's fees.
      expect(value).toBeGreaterThan(950_000 - price - 1_000);
    }
    const total = spent(input, orders);
    expect(total).toBeLessThanOrEqual(10_000_000);
    expect(total / 10_000_000).toBeGreaterThan(0.9);
  });

  it('holds once the initial portfolio is in place', () => {
    const holdings = pool.slice(0, 10).map((c) => holding(c.symbol, Math.floor(950_000 / c.price!), c.price!));
    const invested = holdings.reduce((s, h) => s + h.value, 0);
    const decision = decideBaseline(pureInput({ cash: 10_000_000 - invested, holdings, candidates: pool }));
    expect(decision.orders).toEqual([]);
    expect(decision.market_view).toContain('보유');
  });

  it('respects the daily order limit and finishes the build on a later decision', () => {
    const first = decideBaseline(pureInput({ candidates: pool, maxOrders: 3 }));
    expect(first.orders).toHaveLength(3);

    const holdings = first.orders.map((o) => holding(o.symbol, o.quantity, pool.find((c) => c.symbol === o.symbol)!.price!));
    const invested = holdings.reduce((s, h) => s + h.value, 0);
    const second = decideBaseline(pureInput({ cash: 10_000_000 - invested, holdings, candidates: pool, maxOrders: 3 }));
    expect(second.orders.map((o) => o.symbol)).toEqual(pool.slice(3, 6).map((c) => c.symbol));
  });

  it('respects the position cap and skips symbols without a price', () => {
    const candidates = [candidate('nope', null, { volume: 1e9 }), candidate('big', 10_000, { volume: 1e6 })];
    const input = pureInput({ candidates });
    input.rules.max_position_pct = 0.05;
    const { orders } = decideBaseline(input);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.symbol).toBe('big');
    expect(orders[0]!.quantity * 10_000).toBeLessThanOrEqual(0.05 * 10_000_000);
  });

  it('counts pending buys as owned and never spends more than available cash', () => {
    const input = pureInput({
      candidates: pool,
      availableCash: 2_000_000,
      pendingOrders: [pendingBuy('c00', 50)],
      maxOrders: 20,
    });
    const { orders } = decideBaseline(input);
    expect(orders.some((o) => o.symbol === 'c00')).toBe(false);
    expect(spent(input, orders)).toBeLessThanOrEqual(2_000_000);
  });
});

describe('rule strategies and ETFs', () => {
  const etfs = [
    candidate('E1', 50_000, { kind: 'etf', volume: 1e9 }),
    candidate('LEV', 50_000, { kind: 'etf', leverage: 2, underlying: 'E1', volume: 1e9, change_pct: 9 }),
    candidate('INV', 50_000, { kind: 'etf', leverage: -2, underlying: 'E1', volume: 1e9, change_pct: 8 }),
  ];

  it('baseline buys only stocks, even when ETFs have the largest volume', () => {
    const input = pureInput({ candidates: [...etfs, ...pool], maxOrders: 20 });
    const first = decideBaseline(input);
    expect(first.orders.map((o) => o.symbol)).toEqual(pool.slice(0, 5).map((c) => c.symbol));
  });

  it('momentum may buy a plain ETF but never a leveraged or inverse one', () => {
    const input = pureInput({
      candidates: [...etfs.map((c) => (c.symbol === 'E1' ? { ...c, change_pct: 3 } : c)), candidate('S1', 10_000, { change_pct: 2 })],
    });
    const decision = decideMomentum(input);
    expect(decision.orders.map((o) => o.symbol)).toEqual(['E1', 'S1']);
  });
});

describe('momentum strategy', () => {
  it('never proposes more than 5 orders in one decision', () => {
    const losers = Array.from({ length: 7 }, (_, i) => candidate(`l${i}`, 10_000, { change_pct: -3 }));
    const gainers = [candidate('g1', 10_000, { change_pct: 4 }), candidate('g2', 10_000, { change_pct: 3 })];
    const decision = decideMomentum(
      pureInput({ holdings: losers.map((c) => holding(c.symbol, 5, 10_000)), candidates: [...losers, ...gainers], maxOrders: 20 }),
    );
    expect(decision.orders).toHaveLength(5);
    expect(decision.orders.every((o) => o.side === 'SELL')).toBe(true);
    expect(DecisionSchema.safeParse(decision).success).toBe(true);
  });

  it('sells holdings that fell more than 2% and buys the top two gainers above +1%', () => {
    const candidates = [
      candidate('loser', 20_000, { change_pct: -2.5 }),
      candidate('flat', 20_000, { change_pct: -1.5 }),
      candidate('g1', 10_000, { change_pct: 4 }),
      candidate('g2', 30_000, { change_pct: 3 }),
      candidate('g3', 10_000, { change_pct: 2 }),
      candidate('tiny', 10_000, { change_pct: 0.9 }),
    ];
    const holdings = [holding('loser', 30, 20_000), holding('flat', 10, 20_000)];
    const input = pureInput({ cash: 9_000_000, holdings, candidates });
    const { orders } = decideMomentum(input);

    expect(orders.filter((o) => o.side === 'SELL')).toEqual([expect.objectContaining({ symbol: 'loser', quantity: 30 })]);
    const buys = orders.filter((o) => o.side === 'BUY');
    expect(buys.map((o) => o.symbol)).toEqual(['g1', 'g2']);
    const equity = input.portfolio.equity;
    for (const b of buys) {
      const price = candidates.find((c) => c.symbol === b.symbol)!.price!;
      expect(b.quantity * price).toBeLessThanOrEqual(0.2 * equity);
      expect(b.quantity * price).toBeGreaterThan(0.2 * equity - price - 0.01 * equity);
    }
  });

  it('skips gainers it already owns and holds when nothing qualifies', () => {
    const candidates = [candidate('g1', 10_000, { change_pct: 5 }), candidate('g2', 10_000, { change_pct: 0.5 })];
    const decision = decideMomentum(pureInput({ holdings: [holding('g1', 10, 10_000)], candidates }));
    expect(decision.orders).toEqual([]);
    expect(decision.market_view).toContain('관망');
  });

  it('does not sell shares already committed to pending sells, and stops at the daily limit', () => {
    const candidates = [candidate('a', 10_000, { change_pct: -3 }), candidate('g', 10_000, { change_pct: 3 })];
    const pendingSell = { ...pendingBuy('a', 10), side: 'SELL' as const };
    const input = pureInput({
      holdings: [holding('a', 10, 10_000)],
      candidates,
      pendingOrders: [pendingSell],
      ordersToday: 9,
      maxOrders: 10,
    });
    const { orders } = decideMomentum(input);
    expect(orders).toEqual([expect.objectContaining({ symbol: 'g', side: 'BUY' })]);
  });
});
