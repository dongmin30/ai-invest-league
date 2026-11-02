import type {
  AgentProvider,
  Currency,
  LeagueMarket,
  LeagueStatus,
  LeagueType,
  Market,
  OrderStatus,
  Quote,
} from '@shared/api-types';

const krw = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });

/** Currency of a symbol market, or of a league (통합 leagues keep one KRW account). */
export function currencyOf(market: LeagueMarket): Currency {
  return market === 'US' ? 'USD' : 'KRW';
}

/** KRW `1,234,567원`, USD `$1,234.56` (sign before the symbol). */
export function formatMoney(currency: Currency, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  if (currency === 'KRW') return `${krw.format(Math.round(value))}원`;
  const sign = value < 0 ? '-' : '';
  return `${sign}$${usd.format(Math.abs(value))}`;
}

/** Money with an explicit + sign for gains, used for P&L. */
export function formatSignedMoney(currency: Currency, value: number): string {
  return value > 0 ? `+${formatMoney(currency, value)}` : formatMoney(currency, value);
}

export function formatPrice(market: Market, value: number | null | undefined): string {
  return formatMoney(currencyOf(market), value);
}

/** `≈ 1,234,567원` for a native USD amount at `rate` KRW per USD; `-` without a rate. */
export function formatKrwEquivalent(usd: number | null | undefined, rate: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || !rate) return '-';
  return `≈ ${formatMoney('KRW', usd * rate)}`;
}

const fxRate = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** USD/KRW rate: `1,335.48`. */
export function formatFxRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '-';
  return fxRate.format(rate);
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return integer.format(value);
}

/** Percent points with sign: `2.5` -> `+2.50%`. */
export function formatPctPoints(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const fixed = value.toFixed(digits);
  if (Number(fixed) === 0) return `${(0).toFixed(digits)}%`;
  return `${value > 0 ? '+' : ''}${fixed}%`;
}

/** Fraction with sign: `0.031` -> `+3.10%`. */
export function formatRate(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '-';
  return formatPctPoints(value * 100, digits);
}

/** Korean convention: up is red, down is blue. */
export function signClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'text-slate-500 dark:text-slate-400';
  return value > 0 ? 'text-up' : 'text-down';
}

const dateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const fullDateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const timeOnly = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const hourMinute = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** All times are shown in KST. */
export function formatDateTime(ts: number | null | undefined): string {
  return ts ? dateTime.format(ts) : '-';
}

export function formatFullDateTime(ts: number | null | undefined): string {
  return ts ? fullDateTime.format(ts) : '-';
}

export function formatTime(ts: number | null | undefined): string {
  return ts ? timeOnly.format(ts) : '-';
}

export function formatHourMinute(ts: number | null | undefined): string {
  return ts ? hourMinute.format(ts) : '-';
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}일 ${clock}` : clock;
}

export const MARKET_LABEL: Record<LeagueMarket, string> = { KR: '국내', US: '미국', ALL: '통합' };

export const LEAGUE_TYPE_LABEL: Record<LeagueType, string> = {
  '3d': '3일',
  '1w': '1주',
  '1m': '1개월',
  custom: '커스텀',
};

export const LEAGUE_STATUS_LABEL: Record<LeagueStatus, string> = {
  recruiting: '모집중',
  active: '진행중',
  finished: '종료',
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: '대기',
  filled: '체결',
  canceled: '취소',
  rejected: '거부',
};

export const PROVIDER_LABEL: Record<AgentProvider, string> = {
  claude: 'Claude',
  ollama: '로컬 LLM',
  rule: '규칙 봇',
};

export const PRICE_SOURCE_LABEL: Record<Quote['source'], string> = {
  yahoo: 'Yahoo Finance (지연될 수 있음)',
  kis: '한국투자증권 Open API',
  sim: '시뮬레이션 (가상 시세)',
};
