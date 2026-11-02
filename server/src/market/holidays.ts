import type { Market } from '../../../shared/api-types';

// Full-day market closures (weekends excluded), market-local YYYY-MM-DD.
// Compiled from known holiday rules; verify against the official calendars before relying on them:
//   KRX: https://open.krx.co.kr (휴장일 안내)   NYSE: https://www.nyse.com/markets/hours-calendars
// NYSE early closes (13:00 ET) are not modeled; those days are treated as full sessions.
export const HOLIDAYS: Record<Market, ReadonlySet<string>> = {
  KR: new Set([
    // 2026
    '2026-01-01', // 신정
    '2026-02-16', // 설날 연휴
    '2026-02-17', // 설날
    '2026-02-18', // 설날 연휴
    '2026-03-02', // 삼일절 대체공휴일 (3/1 일)
    '2026-05-01', // 근로자의 날
    '2026-05-05', // 어린이날
    '2026-05-25', // 부처님오신날 대체공휴일 (5/24 일)
    '2026-06-03', // 제9회 전국동시지방선거
    '2026-08-17', // 광복절 대체공휴일 (8/15 토)
    '2026-09-24', // 추석 연휴
    '2026-09-25', // 추석
    '2026-10-05', // 개천절 대체공휴일 (10/3 토)
    '2026-10-09', // 한글날
    '2026-12-25', // 성탄절
    '2026-12-31', // 연말 휴장일
    // 2027
    '2027-01-01', // 신정
    '2027-02-08', // 설날 연휴
    '2027-02-09', // 설날 대체공휴일 (2/7 일)
    '2027-03-01', // 삼일절
    '2027-05-05', // 어린이날
    '2027-05-13', // 부처님오신날
    '2027-08-16', // 광복절 대체공휴일 (8/15 일)
    '2027-09-14', // 추석 연휴
    '2027-09-15', // 추석
    '2027-09-16', // 추석 연휴
    '2027-10-04', // 개천절 대체공휴일 (10/3 일)
    '2027-10-11', // 한글날 대체공휴일 (10/9 토)
    '2027-12-27', // 성탄절 대체공휴일 (12/25 토)
    '2027-12-31', // 연말 휴장일
  ]),
  US: new Set([
    // 2026
    '2026-01-01', // New Year's Day
    '2026-01-19', // Martin Luther King Jr. Day
    '2026-02-16', // Washington's Birthday
    '2026-04-03', // Good Friday
    '2026-05-25', // Memorial Day
    '2026-06-19', // Juneteenth
    '2026-07-03', // Independence Day (observed)
    '2026-09-07', // Labor Day
    '2026-11-26', // Thanksgiving Day
    '2026-12-25', // Christmas Day
    // 2027
    '2027-01-01', // New Year's Day
    '2027-01-18', // Martin Luther King Jr. Day
    '2027-02-15', // Washington's Birthday
    '2027-03-26', // Good Friday
    '2027-05-31', // Memorial Day
    '2027-06-18', // Juneteenth (observed)
    '2027-07-05', // Independence Day (observed)
    '2027-09-06', // Labor Day
    '2027-11-25', // Thanksgiving Day
    '2027-12-24', // Christmas Day (observed)
  ]),
};

export function isHoliday(market: Market, date: string): boolean {
  return HOLIDAYS[market].has(date);
}
