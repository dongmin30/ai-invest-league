import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import {
  addLeagueTradingDays,
  addTradingDays,
  closingMarketOf,
  isLeagueOpen,
  isUnifiedTradingDay,
  leagueTradeDate,
  nextLeagueOpen,
  unifiedSessionBounds,
  isMarketOpen,
  isTradingDay,
  marketDate,
  nextClose,
  nextOpen,
} from '../../src/market/calendar';

// Wall-clock helpers: KST is UTC+9; New York is UTC-4 (EDT) or UTC-5 (EST).
const kst = (y: number, mo: number, d: number, h: number, mi = 0, s = 0, ms = 0) =>
  Date.UTC(y, mo - 1, d, h - 9, mi, s, ms);
const edt = (y: number, mo: number, d: number, h: number, mi = 0, s = 0, ms = 0) =>
  Date.UTC(y, mo - 1, d, h + 4, mi, s, ms);
const est = (y: number, mo: number, d: number, h: number, mi = 0, s = 0, ms = 0) =>
  Date.UTC(y, mo - 1, d, h + 5, mi, s, ms);

afterEach(() => {
  config.simAlwaysOpen = false;
});

describe('isMarketOpen KR (Asia/Seoul)', () => {
  // 2026-10-19 is a Monday.
  it('opens at 09:00 and closes after 15:30', () => {
    expect(isMarketOpen('KR', kst(2026, 10, 19, 8, 59))).toBe(false);
    expect(isMarketOpen('KR', kst(2026, 10, 19, 9, 0))).toBe(true);
    expect(isMarketOpen('KR', kst(2026, 10, 19, 15, 30))).toBe(true);
    expect(isMarketOpen('KR', kst(2026, 10, 19, 15, 30, 0, 1))).toBe(false);
    expect(isMarketOpen('KR', kst(2026, 10, 19, 15, 31))).toBe(false);
  });

  it('is closed on weekends and holidays', () => {
    expect(isMarketOpen('KR', kst(2026, 10, 17, 10, 0))).toBe(false); // Saturday
    expect(isMarketOpen('KR', kst(2026, 10, 18, 10, 0))).toBe(false); // Sunday
    expect(isMarketOpen('KR', kst(2026, 10, 9, 10, 0))).toBe(false); // Hangul Day (Friday)
  });
});

describe('isMarketOpen US (America/New_York)', () => {
  it('uses EDT in summer: 09:30-16:00', () => {
    // 2026-07-15 is a Wednesday.
    expect(isMarketOpen('US', edt(2026, 7, 15, 9, 29))).toBe(false);
    expect(isMarketOpen('US', edt(2026, 7, 15, 9, 30))).toBe(true);
    expect(isMarketOpen('US', edt(2026, 7, 15, 16, 0))).toBe(true);
    expect(isMarketOpen('US', edt(2026, 7, 15, 16, 1))).toBe(false);
  });

  it('uses EST in winter: 09:30-16:00', () => {
    // 2026-12-02 is a Wednesday.
    expect(isMarketOpen('US', est(2026, 12, 2, 9, 29))).toBe(false);
    expect(isMarketOpen('US', est(2026, 12, 2, 9, 30))).toBe(true);
    expect(isMarketOpen('US', est(2026, 12, 2, 16, 0))).toBe(true);
    expect(isMarketOpen('US', est(2026, 12, 2, 16, 1))).toBe(false);
    // 09:30 at the summer offset is 08:30 EST in December: still closed.
    expect(isMarketOpen('US', edt(2026, 12, 2, 9, 30))).toBe(false);
  });

  it('is closed on weekends and holidays', () => {
    expect(isMarketOpen('US', est(2026, 11, 28, 11, 0))).toBe(false); // Saturday
    expect(isMarketOpen('US', est(2026, 11, 26, 11, 0))).toBe(false); // Thanksgiving
    expect(isMarketOpen('US', est(2026, 11, 27, 11, 0))).toBe(true);
  });
});

describe('isTradingDay / marketDate', () => {
  it('excludes weekends and holidays', () => {
    expect(isTradingDay('KR', '2026-10-19')).toBe(true);
    expect(isTradingDay('KR', '2026-10-17')).toBe(false);
    expect(isTradingDay('KR', '2026-12-31')).toBe(false);
    expect(isTradingDay('US', '2026-12-31')).toBe(true);
    expect(isTradingDay('US', '2026-07-03')).toBe(false);
  });

  it('returns the market-local date', () => {
    const at = Date.UTC(2026, 9, 18, 15, 30); // 2026-10-19 00:30 KST, 2026-10-18 11:30 EDT
    expect(marketDate('KR', at)).toBe('2026-10-19');
    expect(marketDate('US', at)).toBe('2026-10-18');
  });
});

describe('nextOpen / nextClose', () => {
  it('skips the weekend after Friday close', () => {
    expect(nextOpen('KR', kst(2026, 10, 16, 16, 0))).toBe(kst(2026, 10, 19, 9, 0));
    expect(nextClose('KR', kst(2026, 10, 16, 16, 0))).toBe(kst(2026, 10, 19, 15, 30));
  });

  it('returns the following session while open and today before the open', () => {
    expect(nextOpen('KR', kst(2026, 10, 19, 10, 0))).toBe(kst(2026, 10, 20, 9, 0));
    expect(nextOpen('KR', kst(2026, 10, 19, 7, 0))).toBe(kst(2026, 10, 19, 9, 0));
    expect(nextClose('KR', kst(2026, 10, 19, 10, 0))).toBe(kst(2026, 10, 19, 15, 30));
    expect(nextClose('US', edt(2026, 7, 15, 10, 0))).toBe(edt(2026, 7, 15, 16, 0));
  });

  it('skips holidays', () => {
    expect(nextOpen('US', est(2026, 11, 25, 17, 0))).toBe(est(2026, 11, 27, 9, 30));
  });
});

describe('addTradingDays', () => {
  it('counts the start day as day 1', () => {
    expect(addTradingDays('KR', kst(2026, 10, 19, 9, 0), 1)).toBe(kst(2026, 10, 19, 15, 30));
  });

  it('skips the weekend', () => {
    // Thu 15, Fri 16, Mon 19
    expect(addTradingDays('KR', kst(2026, 10, 15, 9, 0), 3)).toBe(kst(2026, 10, 19, 15, 30));
  });

  it('skips holidays', () => {
    // Thu 8, (Fri 9 is a holiday), Mon 12, Tue 13
    expect(addTradingDays('KR', kst(2026, 10, 8, 9, 0), 3)).toBe(kst(2026, 10, 13, 15, 30));
  });

  it('handles a weekend that crosses the end of DST', () => {
    // Fri 2026-10-30 (EDT) -> Mon 2026-11-02 (EST)
    expect(addTradingDays('US', edt(2026, 10, 30, 9, 30), 2)).toBe(est(2026, 11, 2, 16, 0));
  });

  it('starts from the next trading day when started on a closed day', () => {
    expect(addTradingDays('KR', kst(2026, 10, 17, 9, 0), 1)).toBe(kst(2026, 10, 19, 15, 30));
  });

  it('rejects non-positive day counts', () => {
    expect(() => addTradingDays('KR', kst(2026, 10, 19, 9, 0), 0)).toThrow(RangeError);
  });
});

describe('simAlwaysOpen', () => {
  it('treats both markets as open at any time', () => {
    config.simAlwaysOpen = true;
    const saturdayNight = kst(2026, 10, 17, 23, 0);
    expect(isMarketOpen('KR', saturdayNight)).toBe(true);
    expect(isMarketOpen('US', saturdayNight)).toBe(true);
    expect(nextOpen('KR', saturdayNight)).toBe(saturdayNight);
    expect(addTradingDays('KR', saturdayNight, 2)).toBe(kst(2026, 10, 19, 0, 0) - 1);
  });
});

describe('ALL (통합) league calendar', () => {
  it('is open during either session and closed in the gap between them (EDT week)', () => {
    expect(isLeagueOpen('ALL', kst(2026, 10, 19, 8, 59))).toBe(false);
    expect(isLeagueOpen('ALL', kst(2026, 10, 19, 10, 0))).toBe(true); // KR
    expect(isLeagueOpen('ALL', kst(2026, 10, 19, 16, 0))).toBe(false); // gap
    expect(isLeagueOpen('ALL', kst(2026, 10, 19, 22, 30))).toBe(true); // US 09:30 EDT
    expect(isLeagueOpen('ALL', kst(2026, 10, 20, 5, 0))).toBe(true); // US 16:00 EDT
    expect(isLeagueOpen('ALL', kst(2026, 10, 20, 5, 1))).toBe(false);
    expect(isLeagueOpen('KR', kst(2026, 10, 19, 22, 30))).toBe(false);
    expect(nextLeagueOpen('ALL', kst(2026, 10, 19, 16, 0))).toBe(kst(2026, 10, 19, 22, 30));
    expect(nextLeagueOpen('ALL', kst(2026, 10, 20, 6, 0))).toBe(kst(2026, 10, 20, 9, 0));
  });

  it('starts the unified day at 08:00 KST, so the US session counts toward the KR date before it', () => {
    expect(leagueTradeDate('ALL', kst(2026, 10, 19, 23, 0))).toBe('2026-10-19');
    expect(leagueTradeDate('ALL', kst(2026, 10, 20, 7, 59, 59, 999))).toBe('2026-10-19');
    expect(leagueTradeDate('ALL', kst(2026, 10, 20, 8, 0))).toBe('2026-10-20');
    expect(leagueTradeDate('KR', kst(2026, 10, 20, 7, 59))).toBe('2026-10-20');
  });

  it('bounds a unified day by the KR open and the following US close (EST after 2026-11-01)', () => {
    expect(unifiedSessionBounds('2026-10-30')).toEqual({ open: kst(2026, 10, 30, 9, 0), close: edt(2026, 10, 30, 16, 0) });
    expect(edt(2026, 10, 30, 16, 0)).toBe(kst(2026, 10, 31, 5, 0));
    expect(unifiedSessionBounds('2026-11-02')).toEqual({ open: kst(2026, 11, 2, 9, 0), close: kst(2026, 11, 3, 6, 0) });
    // 3 unified days from Monday 09:00 KST end Thursday 06:00 KST; 5 end Saturday 06:00 KST.
    expect(addLeagueTradingDays('ALL', kst(2026, 11, 2, 9, 0), 3)).toBe(est(2026, 11, 4, 16, 0));
    expect(est(2026, 11, 4, 16, 0)).toBe(kst(2026, 11, 5, 6, 0));
    expect(addLeagueTradingDays('ALL', kst(2026, 11, 2, 9, 0), 5)).toBe(kst(2026, 11, 7, 6, 0));
    // Counting from a US-session start (Monday 23:30 KST) still makes Monday day 1.
    expect(addLeagueTradingDays('ALL', kst(2026, 11, 2, 23, 30), 1)).toBe(kst(2026, 11, 3, 6, 0));
    expect(closingMarketOf({ market: 'ALL', end_at: kst(2026, 11, 5, 6, 0) })).toBe('US');
    expect(closingMarketOf({ market: 'KR', end_at: kst(2026, 11, 5, 15, 30) })).toBe('KR');
  });

  it('trades a unified day when either market trades', () => {
    expect(isUnifiedTradingDay('2026-12-31')).toBe(true); // KRX year-end closure, NYSE open
    expect(isUnifiedTradingDay('2026-11-26')).toBe(true); // Thanksgiving, KRX open
    expect(isUnifiedTradingDay('2026-12-25')).toBe(false); // both closed
    expect(isUnifiedTradingDay('2026-10-17')).toBe(false); // Saturday
  });

  it('opens at the US open on a KR-only holiday and closes at the KR close on a US-only holiday', () => {
    expect(unifiedSessionBounds('2026-12-31').open).toBe(est(2026, 12, 31, 9, 30)); // 23:30 KST
    expect(nextLeagueOpen('ALL', kst(2026, 12, 31, 8, 0))).toBe(kst(2026, 12, 31, 23, 30));
    expect(unifiedSessionBounds('2026-11-26').close).toBe(kst(2026, 11, 26, 15, 30));
    const end = addLeagueTradingDays('ALL', kst(2026, 11, 24, 9, 0), 3);
    expect(end).toBe(kst(2026, 11, 26, 15, 30));
    expect(closingMarketOf({ market: 'ALL', end_at: end })).toBe('KR');
  });

  it('follows the KR calendar and is always open in SIM_ALWAYS_OPEN mode', () => {
    config.simAlwaysOpen = true;
    const saturday = kst(2026, 10, 17, 3, 0);
    expect(isLeagueOpen('ALL', saturday)).toBe(true);
    expect(nextLeagueOpen('ALL', saturday)).toBe(saturday);
    expect(addLeagueTradingDays('ALL', saturday, 3)).toBe(addTradingDays('KR', saturday, 3));
    expect(closingMarketOf({ market: 'ALL', end_at: addTradingDays('KR', saturday, 3) })).toBe('KR');
  });

  it('counts the daily order limit by the KR date in SIM_ALWAYS_OPEN mode, like its KR-calendar trading days', () => {
    config.simAlwaysOpen = true;
    const wed0700 = kst(2026, 10, 21, 7, 0);
    expect(leagueTradeDate('ALL', wed0700)).toBe('2026-10-21'); // not Tuesday's unified day
    expect(leagueTradeDate('ALL', kst(2026, 10, 20, 23, 59))).toBe('2026-10-20');
    expect(leagueTradeDate('ALL', kst(2026, 10, 21, 0, 0))).toBe('2026-10-21');
    // A 1-day league started then runs through Wednesday's KR date, the same day the limit counts.
    expect(addLeagueTradingDays('ALL', wed0700, 1)).toBe(kst(2026, 10, 22, 0, 0) - 1);
    config.simAlwaysOpen = false;
    expect(leagueTradeDate('ALL', wed0700)).toBe('2026-10-20');
  });
});
