import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { createLeague, finishLeague, updateLeagueStatuses } from '../../src/engine/leagues';
import { matchOrders } from '../../src/engine/matcher';
import { availableCash, equityOf, getPortfolio } from '../../src/engine/portfolio';
import { getHolding, getLeagueRow, getOrderRow } from '../../src/engine/store';
import { closingMarketOf } from '../../src/market/calendar';
import { clearFx, getFx, loadStoredFx } from '../../src/market/fx';
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
  setFxRate,
} from './helpers';

// 통합 (ALL) leagues: KR + US symbols in one KRW account, USD converted at fill time.
// Monday 2026-10-19 (EDT): KR 09:00–15:30 KST, US 22:30–05:00 KST.

const SAMSUNG = '005930';
const KODEX200 = '069500';
const APPLE = 'AAPL';
const START = 10_000_000;
/** Tuesday 2026-10-20 05:00 KST: the US close of Monday's session. */
const US_CLOSE = Date.UTC(2026, 9, 19, 20, 0);
/** Tuesday 2026-10-20 09:00 KST. */
const KR_OPEN_TUE = KR_OPEN + 24 * HOUR;

function setLeague(leagueId: number, column: 'max_position_pct' | 'max_orders_per_day', value: number): void {
  db.prepare(`UPDATE leagues SET ${column} = ? WHERE id = ?`).run(value, leagueId);
}

beforeEach(() => resetEngineState(KR_OPEN + HOUR));
afterEach(() => restoreEngineState());

describe('placeOrder in an ALL league', () => {
  it('trades both pools with KRW cash and unified-day defaults', () => {
    const { leagueId, participantId } = activeLeague('ALL');
    expect(getLeagueRow(leagueId)).toMatchObject({
      market: 'ALL',
      currency: 'KRW',
      start_cash: START,
      fx_spread: 0.001,
      decision_interval_min: 120,
      max_orders_per_day: 15,
      // Five unified days from Monday: ends at Friday's US close (Saturday 05:00 KST).
      end_at: Date.UTC(2026, 9, 23, 20, 0),
    });
    feed(quote(SAMSUNG, 80_000), quote(APPLE, 200));
    setFxRate(1300);
    expect(buy(participantId, SAMSUNG, 1).status).toBe('pending');
    expect(buy(participantId, APPLE, 1).status).toBe('pending');
  });

  it('refuses US symbols until a USD/KRW rate exists (no_fx); KR symbols need none', () => {
    const { participantId } = activeLeague('ALL');
    feed(quote(SAMSUNG, 80_000), quote(APPLE, 200));
    expect(() => buy(participantId, APPLE, 1)).toThrow(expect.objectContaining({ code: 'no_fx' }));
    expect(buy(participantId, SAMSUNG, 1).status).toBe('pending');
  });

  it('reserves US BUY cash at the spread-applied rate (ref_fx) and caps the position at the mid', () => {
    setClock(US_OPEN + MIN);
    const { participantId } = activeLeague('ALL');
    setFxRate(1300);
    feed(quote(APPLE, 200));
    const order = buy(participantId, APPLE, 10);
    // 10 × $200 × 1301.3 = 2,602,600 + 0.1% fee 2,603.
    expect(getOrderRow(order.id)).toMatchObject({ ref_fx: 1301.3, ref_price: 200, trade_date: '2026-10-19' });
    expect(availableCash(participantId)).toBe(START - 2_605_203);
    // 40% of 10,000,000 = 4,000,000: 16 more shares would be (10 + 16) × 200 × 1300 = 6,760,000 at the mid.
    expect(() => buy(participantId, APPLE, 6)).toThrow(expect.objectContaining({ code: 'position_cap' }));
    expect(buy(participantId, APPLE, 5).status).toBe('pending'); // 15 × 200 × 1300 = 3,900,000
  });

  it('refuses symbols whose market does not open again before the league ends (session_after_end)', () => {
    // One unified day: Monday KR session + the US session ending Tuesday 05:00 KST.
    const { leagueId, participantId } = activeLeague('ALL', { duration_days: 1 });
    expect(getLeagueRow(leagueId)!.end_at).toBe(US_CLOSE);
    setClock(KR_CLOSE + 30 * MIN); // 16:00 KST: KR closed, US opens at 22:30
    feed(quote(SAMSUNG, 80_000), quote(APPLE, 200));
    setFxRate(1300);
    expect(() => buy(participantId, SAMSUNG, 1)).toThrow(expect.objectContaining({ code: 'session_after_end' }));
    expect(buy(participantId, APPLE, 1).status).toBe('pending');
  });

  it('counts one daily limit per unified day, which starts at 08:00 KST', () => {
    const { leagueId, participantId } = activeLeague('ALL');
    setLeague(leagueId, 'max_orders_per_day', 2);
    feed(quote(SAMSUNG, 80_000));
    buy(participantId, SAMSUNG, 1); // Monday 10:00 KST
    setClock(US_OPEN + 30 * MIN); // Monday 23:00 KST, same unified day
    buy(participantId, SAMSUNG, 1);
    setClock(KR_OPEN_TUE - HOUR - 1); // Tuesday 07:59:59.999 KST: still Monday's unified day
    expect(() => buy(participantId, SAMSUNG, 1)).toThrow(expect.objectContaining({ code: 'daily_limit' }));
    expect(getPortfolio(participantId).orders_today).toBe(2);
    setClock(KR_OPEN_TUE - HOUR); // 08:00 KST: a new unified day
    expect(getPortfolio(participantId).orders_today).toBe(0);
    expect(getOrderRow(buy(participantId, SAMSUNG, 1).id)!.trade_date).toBe('2026-10-20');
  });
});

describe('matchOrders in an ALL league', () => {
  function usBuy(qty = 10, price = 200, fx = 1300) {
    setClock(US_OPEN + MIN);
    const ids = activeLeague('ALL');
    setFxRate(fx);
    feed(quote(APPLE, price));
    const order = buy(ids.participantId, APPLE, qty);
    setClock(clockNow() + MIN);
    return { ...ids, order };
  }

  it('fills US orders in KRW at the spread-applied rate and records fx_rate and avg_fx', () => {
    const { participantId, order } = usBuy();
    const [filled] = matchOrders(feed(quote(APPLE, 200)));
    expect(filled).toMatchObject({ id: order.id, status: 'filled', fill_price: 200, fee: 2_603, tax: 0, fx_rate: 1301.3 });
    expect(cashOf(participantId)).toBe(START - 2_605_203);
    expect(getHolding(participantId, APPLE)).toMatchObject({ quantity: 10, avg_price: 200, avg_fx: 1301.3 });

    // SELL converts at mid × (1 − spread): 10 × 210 × 1308.69 = 2,748,249 − fee 2,748.
    setFxRate(1310);
    sell(participantId, APPLE, 10);
    setClock(clockNow() + MIN);
    const [sold] = matchOrders(feed(quote(APPLE, 210)));
    expect(sold).toMatchObject({ status: 'filled', fill_price: 210, fee: 2_748, tax: 0, fx_rate: 1308.69 });
    expect(cashOf(participantId)).toBe(START - 2_605_203 + 2_745_501);
  });

  it('weights avg_fx by the USD amount of each buy', () => {
    const { leagueId, participantId } = usBuy();
    setLeague(leagueId, 'max_position_pct', 1);
    matchOrders(feed(quote(APPLE, 200)));
    setFxRate(1400);
    feed(quote(APPLE, 300));
    buy(participantId, APPLE, 10);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(APPLE, 300)));
    // (2,000 × 1301.3 + 3,000 × 1401.4) / 5,000
    const h = getHolding(participantId, APPLE)!;
    expect(h.avg_price).toBe(250);
    expect(h.avg_fx).toBeCloseTo(1361.36, 6);
  });

  it('keeps KR fees and the KR ETF tax exemption, without FX', () => {
    const { participantId } = activeLeague('ALL');
    feed(quote(SAMSUNG, 80_000), quote(KODEX200, 90_000));
    buy(participantId, SAMSUNG, 10);
    buy(participantId, KODEX200, 10);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(SAMSUNG, 80_000), quote(KODEX200, 90_000)));
    sell(participantId, SAMSUNG, 10);
    sell(participantId, KODEX200, 10);
    setClock(clockNow() + MIN);
    const sold = matchOrders(feed(quote(SAMSUNG, 80_000), quote(KODEX200, 91_000)));
    expect(sold.find((o) => o.symbol === SAMSUNG)).toMatchObject({ fee: 120, tax: 1_600, fx_rate: null });
    expect(sold.find((o) => o.symbol === KODEX200)).toMatchObject({ fee: 137, tax: 0, fx_rate: null });
    expect(getHolding(participantId, SAMSUNG)).toBeUndefined();
  });

  it('fills a KR order placed during the US session only after the next KR open', () => {
    setClock(US_OPEN + 30 * MIN); // Monday 23:00 KST
    const { participantId } = activeLeague('ALL');
    feed(quote(SAMSUNG, 80_000));
    const order = buy(participantId, SAMSUNG, 10);
    setClock(clockNow() + 5 * MIN);
    expect(matchOrders(feed(quote(SAMSUNG, 80_500)))).toEqual([]);
    setClock(KR_OPEN_TUE + MIN);
    const [filled] = matchOrders(feed(quote(SAMSUNG, 81_000)));
    expect(filled).toMatchObject({ id: order.id, status: 'filled', fill_price: 81_000, fx_rate: null });
  });

  it('leaves US orders pending while USD/KRW is stale, then fills at the fresh rate', () => {
    setClock(US_OPEN + 40 * MIN);
    const { participantId } = activeLeague('ALL');
    setFxRate(1300, US_OPEN); // 40 minutes old
    feed(quote(APPLE, 200));
    const order = buy(participantId, APPLE, 10);
    setClock(clockNow() + MIN);
    expect(matchOrders(feed(quote(APPLE, 200)))).toEqual([]);
    expect(getOrderRow(order.id)!.status).toBe('pending');

    setFxRate(1310);
    setClock(clockNow() + MIN);
    const [filled] = matchOrders(feed(quote(APPLE, 200)));
    expect(filled).toMatchObject({ id: order.id, status: 'filled', fx_rate: 1311.31 });
  });

  it('rejects a BUY whose cost at the fill-time rate exceeds the free cash', () => {
    setClock(US_OPEN + MIN);
    const { leagueId, participantId } = activeLeague('ALL');
    setLeague(leagueId, 'max_position_pct', 1);
    setFxRate(1300);
    feed(quote(APPLE, 200));
    const order = buy(participantId, APPLE, 38); // 9,889,880 + 9,890 fee at 1301.3
    setFxRate(1320, clockNow() + MIN); // 38 × 200 × 1321.32 = 10,042,032 > 10,000,000
    setClock(clockNow() + MIN);
    const [rejected] = matchOrders(feed(quote(APPLE, 200)));
    expect(rejected).toMatchObject({ id: order.id, status: 'rejected', reject_reason: '체결 시점에 주문 가능 금액이 부족했습니다.' });
    expect(cashOf(participantId)).toBe(START);
  });
});

describe('portfolio of an ALL league', () => {
  function holdingApple() {
    setClock(US_OPEN + MIN);
    const ids = activeLeague('ALL');
    setFxRate(1300);
    feed(quote(APPLE, 200));
    buy(ids.participantId, APPLE, 10);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(APPLE, 200)));
    return ids;
  }

  it('values US holdings in KRW at the mid: FX +1% is +1% on the position, P&L includes FX', () => {
    const { participantId } = holdingApple();
    const cash = START - 2_605_203;
    expect(equityOf(participantId)).toBe(cash + 2_600_000);
    setFxRate(1313);
    const p = getPortfolio(participantId);
    expect(p.currency).toBe('KRW');
    expect(p.fx).toMatchObject({ pair: 'USDKRW', rate: 1313, stale: false });
    expect(p.holdings).toEqual([
      expect.objectContaining({
        symbol: APPLE,
        currency: 'USD',
        avg_price: 200,
        price: 200,
        fx_rate: 1313,
        value: 2_626_000,
        pnl: 23_400, // 2,626,000 − 10 × 200 × 1301.3
      }),
    ]);
    expect(p.holdings[0]!.pnl_rate).toBeCloseTo(2_626_000 / 2_602_600 - 1, 10);
    expect(p.equity).toBe(cash + 2_626_000);
  });

  it('prices a finished league at the USD/KRW stored at its final snapshot', () => {
    const { leagueId, participantId } = holdingApple();
    setClock(clockNow() + MIN);
    finishLeague(leagueId);
    const frozen = getPortfolio(participantId).equity;
    setClock(clockNow() + 10 * MIN);
    setFxRate(1500);
    const p = getPortfolio(participantId);
    expect(p.holdings[0]).toMatchObject({ fx_rate: 1300, value: 2_600_000 });
    expect(p.equity).toBe(frozen);
  });

  it('keeps a finished league at the rate its final snapshot used when a later fetch lands in the same minute', () => {
    setClock(US_OPEN + HOUR);
    const { leagueId, participantId } = activeLeague('ALL');
    setFxRate(1300, US_OPEN + HOUR);
    feed(quote(APPLE, 200, US_OPEN + HOUR - 1000));
    buy(participantId, APPLE, 10);
    setClock(US_OPEN + HOUR + 5000);
    matchOrders(feed(quote(APPLE, 200, US_OPEN + HOUR + 5000)));
    setClock(US_OPEN + HOUR + 20_000);
    finishLeague(leagueId);
    const final = db.prepare('SELECT equity, fx_rate FROM snapshots WHERE participant_id = ? ORDER BY ts DESC LIMIT 1').get(
      participantId,
    );
    expect(final).toEqual({ equity: START - 2_605_203 + 2_600_000, fx_rate: 1300 });
    const before = getPortfolio(participantId);

    setFxRate(1400, US_OPEN + HOUR + 40_000); // e.g. the forced collect at the close, same minute
    const after = getPortfolio(participantId);
    expect(after.holdings[0]).toMatchObject({ fx_rate: 1300, value: 2_600_000 });
    expect(after.holdings).toEqual(before.holdings);
    expect(after.cash + after.holdings[0]!.value).toBe(after.equity);
    // fx_rates keeps every tick: the earlier row is not overwritten.
    expect(db.prepare('SELECT ts, rate FROM fx_rates ORDER BY ts').all()).toEqual([
      { ts: US_OPEN + HOUR, rate: 1300 },
      { ts: US_OPEN + HOUR + 40_000, rate: 1400 },
    ]);
  });

  it('after a restart, the last stored rate (stale) keeps US holdings valued and US orders accepted; fills wait for a fresh rate', () => {
    const { participantId } = holdingApple(); // bought at 1300 (avg_fx 1301.3)
    setFxRate(1400, clockNow() + MIN);
    setClock(clockNow() + 3 * MIN);
    const live = equityOf(participantId);

    clearFx(); // process restart: fx_rates still holds 1400
    loadStoredFx(); // what src/index.ts does right after migrate()
    expect(getFx()).toMatchObject({ rate: 1400, ts: clockNow() - 2 * MIN, stale: false });
    expect(equityOf(participantId)).toBe(live);
    expect(getPortfolio(participantId).holdings[0]!.fx_rate).toBe(1400);

    // Once the stored rate is stale: valuation and placement still work, the fill waits.
    setClock(clockNow() + 2 * HOUR);
    feed(quote(APPLE, 200));
    expect(getFx()!.stale).toBe(true);
    expect(equityOf(participantId)).toBe(live);
    const order = buy(participantId, APPLE, 1);
    expect(order.status).toBe('pending');
    setClock(clockNow() + MIN);
    expect(matchOrders(feed(quote(APPLE, 200)))).toEqual([]);
    setFxRate(1350);
    expect(matchOrders(feed(quote(APPLE, 200, clockNow() + 1)))).toMatchObject([{ id: order.id, status: 'filled' }]);
  });

  it('single-market holdings keep fx_rate 1 and their native currency', () => {
    setClock(US_OPEN + MIN);
    const { participantId } = activeLeague('US');
    feed(quote(APPLE, 200));
    buy(participantId, APPLE, 1);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(APPLE, 200)));
    const p = getPortfolio(participantId);
    expect(p.fx).toBeNull();
    expect(p.holdings[0]).toMatchObject({ currency: 'USD', fx_rate: 1, value: 200 });
  });
});

describe('ALL league lifecycle', () => {
  it('ends official leagues at the US close of the last unified day (EST)', () => {
    // Monday 2026-11-02 09:00 KST, after the US DST change: US closes 06:00 KST.
    const mon = Date.UTC(2026, 10, 2, 0, 0);
    const three = createLeague({ name: '3일', market: 'ALL', type: '3d', is_public: true, owner_id: null, start_at: mon });
    const week = createLeague({ name: '1주', market: 'ALL', type: '1w', is_public: true, owner_id: null, start_at: mon });
    expect(three.end_at).toBe(Date.UTC(2026, 10, 4, 21, 0)); // Thursday 06:00 KST
    expect(week.end_at).toBe(Date.UTC(2026, 10, 6, 21, 0)); // Saturday 06:00 KST
    expect(three).toMatchObject({ decision_interval_min: 60, max_orders_per_day: 30, fx_spread: 0.001 });
    expect(week).toMatchObject({ decision_interval_min: 120, max_orders_per_day: 15 });
    expect(closingMarketOf(getLeagueRow(three.id)!)).toBe('US');
  });

  it('ends at the KR close when the US is closed on the last day (Thanksgiving)', () => {
    // Tuesday 2026-11-24 09:00 KST + 3 unified days: Thursday 11-26 has no US session.
    const league = createLeague({
      name: '추수감사절',
      market: 'ALL',
      type: '3d',
      is_public: true,
      owner_id: null,
      start_at: Date.UTC(2026, 10, 24, 0, 0),
    });
    expect(league.end_at).toBe(Date.UTC(2026, 10, 26, 6, 30)); // 11-26 15:30 KST
    expect(closingMarketOf(getLeagueRow(league.id)!)).toBe('KR');
  });

  it('finishes at the US close once the US closing prints are in, ignoring KR symbols', () => {
    const { leagueId, participantId } = activeLeague('ALL', { duration_days: 1 });
    const hold = db.prepare('INSERT INTO holdings (participant_id, symbol, quantity, avg_price, avg_fx) VALUES (?, ?, 1, ?, ?)');
    hold.run(participantId, SAMSUNG, 80_000, 1);
    hold.run(participantId, APPLE, 200, 1300);
    setFxRate(1300, US_CLOSE - MIN);
    feed(quote(SAMSUNG, 80_000, KR_CLOSE), quote(APPLE, 200, US_CLOSE - MIN));
    setClock(US_CLOSE + MIN);
    expect(updateLeagueStatuses().finished).toEqual([]);
    feed(quote(APPLE, 201, US_CLOSE + 5_000));
    expect(updateLeagueStatuses().finished).toEqual([leagueId]);
  });
});
