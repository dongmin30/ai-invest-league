import type { Currency, LeagueMarket, LeagueType } from '../../../shared/api-types';
import { DEFAULT_FX_SPREAD } from '../market/fx';
import { getSymbol } from '../market/symbols';

export interface LeagueMarketDefaults {
  currency: Currency;
  start_cash: number;
  fee_rate: number;
  /** Applied to the SELL amount only. */
  tax_rate: number;
  /** FX conversion cost per side for US symbols (ALL leagues only). */
  fx_spread: number;
}

export interface LeagueTypeDefaults {
  /** Trading days the league runs; null for custom leagues, which take `duration_days`. */
  trading_days: number | null;
  decision_interval_min: number;
  max_orders_per_day: number;
}

/**
 * ALL (통합) leagues store the KR rates in fee_rate/tax_rate, but trades use the rates of the
 * symbol's own market (ratesFor), so KR and US symbols cost what they cost in their own leagues.
 */
export const LEAGUE_DEFAULTS: Record<LeagueMarket, LeagueMarketDefaults> = {
  KR: { currency: 'KRW', start_cash: 10_000_000, fee_rate: 0.00015, tax_rate: 0.002, fx_spread: 0 },
  US: { currency: 'USD', start_cash: 10_000, fee_rate: 0.001, tax_rate: 0, fx_spread: 0 },
  ALL: { currency: 'KRW', start_cash: 10_000_000, fee_rate: 0.00015, tax_rate: 0.002, fx_spread: DEFAULT_FX_SPREAD },
};

export const TYPE_DEFAULTS: Record<LeagueType, LeagueTypeDefaults> = {
  '3d': { trading_days: 3, decision_interval_min: 30, max_orders_per_day: 20 },
  '1w': { trading_days: 5, decision_interval_min: 60, max_orders_per_day: 10 },
  '1m': { trading_days: 20, decision_interval_min: 180, max_orders_per_day: 5 },
  custom: { trading_days: null, decision_interval_min: 60, max_orders_per_day: 10 },
};

/**
 * ALL leagues trade two sessions per unified day, so decisions are half as frequent and the
 * daily order limit (one per unified day, see leagueTradeDate) is 1.5×.
 */
const UNIFIED_TYPE_DEFAULTS: Record<LeagueType, LeagueTypeDefaults> = {
  '3d': { trading_days: 3, decision_interval_min: 60, max_orders_per_day: 30 },
  '1w': { trading_days: 5, decision_interval_min: 120, max_orders_per_day: 15 },
  '1m': { trading_days: 20, decision_interval_min: 360, max_orders_per_day: 8 },
  custom: { trading_days: null, decision_interval_min: 120, max_orders_per_day: 15 },
};

export function typeDefaultsFor(type: LeagueType, market: LeagueMarket): LeagueTypeDefaults {
  return market === 'ALL' ? UNIFIED_TYPE_DEFAULTS[type] : TYPE_DEFAULTS[type];
}

export const CUSTOM_MAX_DAYS = 20;

/** Official leagues stay open to late joiners for this long after start_at. */
export const OFFICIAL_JOIN_GRACE_MS = 24 * 60 * 60 * 1000;

const DECIMALS: Record<Currency, number> = { KRW: 0, USD: 2 };

/** Rounds half away from zero to the currency's minor unit (KRW 0 decimals, USD 2). */
export function roundMoney(currency: Currency, v: number): number {
  const factor = 10 ** DECIMALS[currency];
  const rounded = (Math.sign(v) * Math.round(Math.abs(v) * factor * (1 + Number.EPSILON))) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * SELL tax rate for `symbol` in a league whose rate is `leagueTaxRate`. Korean ETFs are
 * exempt from the securities transaction tax (증권거래세), so KR ETFs pay 0; everything
 * else pays the league rate (KR stocks 0.20%, US 0).
 */
export function taxRateFor(symbol: string, leagueTaxRate: number): number {
  const info = getSymbol(symbol);
  return info?.market === 'KR' && info.kind === 'etf' ? 0 : leagueTaxRate;
}

/**
 * Fee and SELL tax rates for `symbol` in `league`. Single-market leagues use their own columns
 * (plus taxRateFor's KR ETF exemption); ALL leagues use the defaults of the symbol's market
 * (KR stock 0.015% + 0.2% SELL tax, KR ETF no tax, US 0.1%).
 */
export function ratesFor(
  league: { market: LeagueMarket; fee_rate: number; tax_rate: number },
  symbol: string,
): { fee_rate: number; tax_rate: number } {
  if (league.market !== 'ALL') return { fee_rate: league.fee_rate, tax_rate: taxRateFor(symbol, league.tax_rate) };
  const d = LEAGUE_DEFAULTS[getSymbol(symbol)?.market ?? 'KR'];
  return { fee_rate: d.fee_rate, tax_rate: taxRateFor(symbol, d.tax_rate) };
}

/** Whether trades of `symbol` convert USD to KRW: US symbols in ALL leagues. */
export function convertsFx(leagueMarket: LeagueMarket, symbol: string): boolean {
  return leagueMarket === 'ALL' && getSymbol(symbol)?.market === 'US';
}

export interface TradeCost {
  amount: number;
  fee: number;
  tax: number;
  /** BUY: cash debited (amount + fee). SELL: cash credited (amount − fee − tax). */
  cash: number;
}

/**
 * Cash effect of a trade. Placement-time reservations and fills both use this, so an
 * order that was affordable at placement never fails the fill re-check at the same price.
 * `fx` converts the native price into the league currency (US symbols in ALL leagues: the
 * spread-applied USD/KRW); fee and tax are charged on the converted amount.
 */
export function tradeCost(
  currency: Currency,
  side: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  feeRate: number,
  taxRate: number,
  fx = 1,
): TradeCost {
  const amount = roundMoney(currency, quantity * price * fx);
  const fee = roundMoney(currency, amount * feeRate);
  if (side === 'BUY') return { amount, fee, tax: 0, cash: roundMoney(currency, amount + fee) };
  const tax = roundMoney(currency, amount * taxRate);
  return { amount, fee, tax, cash: roundMoney(currency, amount - fee - tax) };
}
