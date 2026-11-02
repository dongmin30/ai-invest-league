import type { LeagueMarket, LeagueSummary, Market, OrderSide, SymbolRow } from '@shared/api-types';

// Mirrors server engine/fees.ts LEAGUE_DEFAULTS. LeagueSummary does not expose per-league
// rates, and every league is created with these defaults, so the UI uses them for estimates.
// ALL (통합) leagues store the KR rates, but the server charges each symbol its own market's rates
// (US 0.1% fee, no tax) plus the fx_spread on US symbols (see ratesFor below).
export const MARKET_RULES: Record<LeagueMarket, { start_cash: number; fee_rate: number; tax_rate: number }> = {
  KR: { start_cash: 10_000_000, fee_rate: 0.00015, tax_rate: 0.002 },
  US: { start_cash: 10_000, fee_rate: 0.001, tax_rate: 0 },
  ALL: { start_cash: 10_000_000, fee_rate: 0.00015, tax_rate: 0.002 },
};

export interface TradeRates {
  fee_rate: number;
  /** SELL tax actually charged for this symbol (0 for Korean ETFs). */
  tax_rate: number;
  /** The market's SELL tax before the ETF exemption, so the UI can say "ETF 면제". */
  base_tax_rate: number;
}

/**
 * Mirrors server engine/fees.ts ratesFor + taxRateFor: a single-market league uses its own rates;
 * a 통합 league charges each symbol its own market's rates. Korean ETFs are exempt from the
 * securities transaction tax.
 */
export function ratesFor(leagueMarket: LeagueMarket, symbol: Pick<SymbolRow, 'market' | 'kind'> | null): TradeRates {
  const market: LeagueMarket = leagueMarket === 'ALL' ? (symbol?.market ?? 'KR') : leagueMarket;
  const rules = MARKET_RULES[market];
  const exempt = market === 'KR' && symbol?.kind === 'etf';
  return { fee_rate: rules.fee_rate, tax_rate: exempt ? 0 : rules.tax_rate, base_tax_rate: rules.tax_rate };
}

/** A US symbol in a 통합 league: priced in USD, settled in KRW at fill. */
export function convertsFx(league: Pick<LeagueSummary, 'market'>, symbolMarket: Market | null | undefined): boolean {
  return league.market === 'ALL' && symbolMarket === 'US';
}

/** Mirrors server market/fx.ts appliedFx: mid × (1 + spread) for BUY, × (1 − spread) for SELL, 4 decimals. */
export function appliedFx(mid: number, side: OrderSide, spread: number): number {
  const rate = side === 'BUY' ? mid * (1 + spread) : mid * (1 - spread);
  return Math.round(rate * 10_000) / 10_000;
}

/** Mirrors server market/fx.ts FX_STALE_MS: US fills in 통합 leagues wait while the rate is older. */
export const FX_STALE_MS = 30 * 60 * 1000;

export const DURATION_MIN = 1;
export const DURATION_MAX = 20;

// Mirrors server engine/fees.ts OFFICIAL_JOIN_GRACE_MS: official leagues accept late joiners
// for this long after they start.
export const OFFICIAL_JOIN_GRACE_MS = 24 * 60 * 60 * 1000;
