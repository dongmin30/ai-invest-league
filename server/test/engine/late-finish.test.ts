import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { db } from '../../src/db/db';
import { hasOverdueLeagues, LATE_FINISH_GRACE_MS, updateLeagueStatuses } from '../../src/engine/leagues';
import { matchOrders } from '../../src/engine/matcher';
import { getPortfolio } from '../../src/engine/portfolio';
import { computeRankings } from '../../src/engine/ranking';
import { lastSnapshot } from '../../src/engine/store';
import { closingPrintWaitMs, YAHOO_KR_CLOSE_WAIT_MS } from '../../src/market/calendar';
import { storeQuotes } from '../../src/market/collector';
import { clearQuotes } from '../../src/market/quoteCache';
import {
  HOUR,
  KR_CLOSE,
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
  setClock,
  setFxRate,
} from './helpers';

const DAY = 24 * HOUR;
const APPLE = 'AAPL';
/** Monday 2026-10-19 16:00 EDT. */
const US_CLOSE = US_OPEN + 6.5 * HOUR;
const CUTOFF = US_CLOSE + closingPrintWaitMs('US');
/** Thursday 01:00 UTC: the Tuesday and Wednesday sessions have come and gone. */
const TWO_SESSIONS_LATER = US_CLOSE + 2 * DAY + 5 * HOUR;

const BUY_PRICE = 200;
const MONDAY_CLOSE = 210;
const WEDNESDAY_CLOSE = 250;

function bar(symbol: string, date: string, close: number): void {
  db.prepare('INSERT INTO daily_bars (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 0)').run(
    symbol,
    date,
    close,
    close,
    close,
    close,
  );
}

const finalReturn = (participantId: number) =>
  db.prepare('SELECT final_return FROM participants WHERE id = ?').pluck().get(participantId) as number;

/** A one-day league holding one AAPL bought at 200 an hour into Monday's US session. */
function holdingLeague(market: 'US' | 'ALL' = 'US') {
  setClock(US_OPEN + HOUR);
  if (market === 'ALL') setFxRate(1400);
  const { leagueId, participantId } = activeLeague(market, { duration_days: 1, start_at: US_OPEN });
  feed(quote(APPLE, BUY_PRICE));
  buy(participantId, APPLE, 1);
  setClock(clockNow() + MIN);
  const filled = feed(quote(APPLE, BUY_PRICE));
  storeQuotes(filled);
  matchOrders(filled);
  expect(getPortfolio(participantId).holdings).toHaveLength(1);
  return { leagueId, participantId };
}

/** The server comes back two sessions after the league ended: the cache holds Wednesday's close. */
function bootTwoSessionsLater() {
  clearQuotes();
  setClock(TWO_SESSIONS_LATER);
  feed(quote(APPLE, WEDNESDAY_CLOSE, US_CLOSE + 2 * DAY));
}

describe('a league that ended while the server was off for more than a session', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('is valued at the close of its last session, not at the prices of the restart', () => {
    const { leagueId, participantId } = holdingLeague();
    bar(APPLE, '2026-10-19', MONDAY_CLOSE);
    bar(APPLE, '2026-10-20', 230);
    bar(APPLE, '2026-10-21', WEDNESDAY_CLOSE);
    bootTwoSessionsLater();

    expect(hasOverdueLeagues()).toBe(true);
    expect(updateLeagueStatuses().finished).toEqual([leagueId]);

    const cash = cashOf(participantId);
    const expected = (cash + MONDAY_CLOSE) / 10_000 - 1;
    expect(finalReturn(participantId)).toBeCloseTo(expected, 10);
    expect(finalReturn(participantId)).not.toBeCloseTo((cash + WEDNESDAY_CLOSE) / 10_000 - 1, 4);

    // The final snapshot is dated at the league's end, and every view reads the same numbers.
    expect(lastSnapshot(participantId)).toMatchObject({ ts: CUTOFF, equity: cash + MONDAY_CLOSE });
    const portfolio = getPortfolio(participantId);
    expect(portfolio.equity).toBe(cash + MONDAY_CLOSE);
    expect(portfolio.holdings[0]).toMatchObject({ symbol: APPLE, price: MONDAY_CLOSE, value: MONDAY_CLOSE });
    expect(computeRankings(leagueId)[0]!.return_rate).toBeCloseTo(expected, 10);
  });

  it('stays put when prices keep moving after it finished', () => {
    const { leagueId, participantId } = holdingLeague();
    bar(APPLE, '2026-10-19', MONDAY_CLOSE);
    bootTwoSessionsLater();
    updateLeagueStatuses();
    const settled = computeRankings(leagueId)[0]!.return_rate;

    setClock(clockNow() + DAY);
    const later = feed(quote(APPLE, 400));
    storeQuotes(later);
    bar(APPLE, '2026-10-22', 400);

    expect(computeRankings(leagueId)[0]!.return_rate).toBe(settled);
    expect(getPortfolio(participantId).holdings[0]!.price).toBe(MONDAY_CLOSE);
  });

  it('uses the last quote stored before its end when there is no daily bar for that session', () => {
    const { participantId } = holdingLeague();
    setClock(US_CLOSE - 2 * HOUR);
    storeQuotes([quote(APPLE, 205)]); // the server went down two hours before the close
    bootTwoSessionsLater();
    updateLeagueStatuses();

    expect(lastSnapshot(participantId)!.equity).toBe(cashOf(participantId) + 205);
    expect(getPortfolio(participantId).holdings[0]!.price).toBe(205);
  });

  it('prefers a closing print stored at the close over the daily bar', () => {
    const { participantId } = holdingLeague();
    bar(APPLE, '2026-10-19', MONDAY_CLOSE);
    setClock(US_CLOSE + MIN);
    storeQuotes([quote(APPLE, 211, US_CLOSE + 5000)]);
    bootTwoSessionsLater();
    updateLeagueStatuses();

    expect(lastSnapshot(participantId)!.equity).toBe(cashOf(participantId) + 211);
  });

  it('ignores the bar of a session that closed after the league ended', () => {
    const { participantId } = holdingLeague();
    bar(APPLE, '2026-10-20', 230); // only a later session is on record
    bootTwoSessionsLater();
    updateLeagueStatuses();

    // No bar up to the end: the fill-time quote (200) is the last price on record.
    expect(lastSnapshot(participantId)!.equity).toBe(cashOf(participantId) + BUY_PRICE);
  });

  it('values US holdings of a 통합 league at the exchange rate stored by its end', () => {
    const { participantId } = holdingLeague('ALL');
    bar(APPLE, '2026-10-19', MONDAY_CLOSE);
    bootTwoSessionsLater();
    setFxRate(1500); // today's rate, two sessions after the end

    updateLeagueStatuses();

    const snapshot = lastSnapshot(participantId)!;
    expect(snapshot.fx_rate).toBe(1400);
    expect(snapshot.equity).toBe(cashOf(participantId) + MONDAY_CLOSE * 1400);
    expect(getPortfolio(participantId).holdings[0]).toMatchObject({ price: MONDAY_CLOSE, fx_rate: 1400 });
  });
});

describe('a league that finishes on time', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('is valued at the live closing quote and is not overdue', () => {
    const { leagueId, participantId } = holdingLeague();
    bar(APPLE, '2026-10-19', 999); // a daily bar is not consulted on time
    setClock(US_CLOSE + MIN);
    feed(quote(APPLE, 212, US_CLOSE + 5000));

    expect(hasOverdueLeagues()).toBe(false);
    expect(updateLeagueStatuses().finished).toEqual([leagueId]);
    expect(lastSnapshot(participantId)).toMatchObject({ ts: US_CLOSE + MIN, equity: cashOf(participantId) + 212 });
  });

  it('counts as overdue only past the closing-print wait plus the grace period', () => {
    holdingLeague();
    setClock(CUTOFF + LATE_FINISH_GRACE_MS);
    expect(hasOverdueLeagues()).toBe(false);
    setClock(CUTOFF + LATE_FINISH_GRACE_MS + 1);
    expect(hasOverdueLeagues()).toBe(true);
  });

  it('with a live KR provider, waits for the Yahoo daily bar to include the close before settling from bars', () => {
    const provider = config.priceProvider;
    config.priceProvider = 'kis';
    try {
      setClock(KR_CLOSE - HOUR);
      activeLeague('KR', { duration_days: 1 });
      // Past the 10-minute closing-print wait of a live provider, but the bar may still lack the close.
      setClock(KR_CLOSE + YAHOO_KR_CLOSE_WAIT_MS + LATE_FINISH_GRACE_MS);
      expect(hasOverdueLeagues()).toBe(false);
      setClock(clockNow() + 1);
      expect(hasOverdueLeagues()).toBe(true);
    } finally {
      config.priceProvider = provider;
    }
  });
});
