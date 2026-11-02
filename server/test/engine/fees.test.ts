import { describe, expect, it } from 'vitest';
import {
  LEAGUE_DEFAULTS,
  TYPE_DEFAULTS,
  convertsFx,
  ratesFor,
  roundMoney,
  taxRateFor,
  tradeCost,
  typeDefaultsFor,
} from '../../src/engine/fees';
import { appliedFx } from '../../src/market/fx';

describe('fees', () => {
  it('exposes the market and type defaults from the spec', () => {
    expect(LEAGUE_DEFAULTS.KR).toEqual({ currency: 'KRW', start_cash: 10_000_000, fee_rate: 0.00015, tax_rate: 0.002, fx_spread: 0 });
    expect(LEAGUE_DEFAULTS.US).toEqual({ currency: 'USD', start_cash: 10_000, fee_rate: 0.001, tax_rate: 0, fx_spread: 0 });
    expect(LEAGUE_DEFAULTS.ALL).toEqual({ currency: 'KRW', start_cash: 10_000_000, fee_rate: 0.00015, tax_rate: 0.002, fx_spread: 0.001 });
    expect(TYPE_DEFAULTS['3d']).toEqual({ trading_days: 3, decision_interval_min: 30, max_orders_per_day: 20 });
    expect(TYPE_DEFAULTS['1w']).toEqual({ trading_days: 5, decision_interval_min: 60, max_orders_per_day: 10 });
    expect(TYPE_DEFAULTS['1m']).toEqual({ trading_days: 20, decision_interval_min: 180, max_orders_per_day: 5 });
    expect(TYPE_DEFAULTS.custom).toEqual({ trading_days: null, decision_interval_min: 60, max_orders_per_day: 10 });
  });

  it('rounds KRW to whole won and USD to cents, half away from zero', () => {
    expect(roundMoney('KRW', 56.25)).toBe(56);
    expect(roundMoney('KRW', 56.5)).toBe(57);
    expect(roundMoney('KRW', -56.5)).toBe(-57);
    expect(roundMoney('USD', 0.56811)).toBe(0.57);
    expect(roundMoney('USD', 1.005)).toBe(1.01);
    expect(roundMoney('USD', 0.1 + 0.2)).toBe(0.3);
    expect(Object.is(roundMoney('USD', -0.001), 0)).toBe(true);
  });

  it('charges the fee on both sides and the tax on SELL only', () => {
    expect(tradeCost('KRW', 'BUY', 10, 70_000, 0.00015, 0.002)).toEqual({ amount: 700_000, fee: 105, tax: 0, cash: 700_105 });
    expect(tradeCost('KRW', 'SELL', 5, 75_000, 0.00015, 0.002)).toEqual({
      amount: 375_000,
      fee: 56,
      tax: 750,
      cash: 374_194,
    });
    expect(tradeCost('USD', 'BUY', 3, 189.37, 0.001, 0)).toEqual({ amount: 568.11, fee: 0.57, tax: 0, cash: 568.68 });
  });

  it('exempts Korean ETFs from the securities transaction tax; KR stocks keep the league rate', () => {
    expect(taxRateFor('005930', 0.002)).toBe(0.002);
    expect(taxRateFor('069500', 0.002)).toBe(0); // KODEX 200
    expect(taxRateFor('252670', 0.002)).toBe(0); // KODEX 200선물인버스2X
    expect(taxRateFor('SPY', 0)).toBe(0);
    expect(taxRateFor('AAPL', 0)).toBe(0);
  });

  it('uses the league rates in single-market leagues and the symbol market defaults in ALL leagues', () => {
    const kr = { market: 'KR' as const, fee_rate: 0.0002, tax_rate: 0.0018 };
    expect(ratesFor(kr, '005930')).toEqual({ fee_rate: 0.0002, tax_rate: 0.0018 });
    expect(ratesFor(kr, '069500')).toEqual({ fee_rate: 0.0002, tax_rate: 0 });
    const all = { market: 'ALL' as const, fee_rate: 0.00015, tax_rate: 0.002 };
    expect(ratesFor(all, '005930')).toEqual({ fee_rate: 0.00015, tax_rate: 0.002 });
    expect(ratesFor(all, '069500')).toEqual({ fee_rate: 0.00015, tax_rate: 0 }); // KR ETF: no tax
    expect(ratesFor(all, 'AAPL')).toEqual({ fee_rate: 0.001, tax_rate: 0 });
    expect(convertsFx('ALL', 'AAPL')).toBe(true);
    expect(convertsFx('ALL', '005930')).toBe(false);
    expect(convertsFx('US', 'AAPL')).toBe(false);
  });

  it('converts the native amount with fx before rounding to won; fee and tax on the KRW amount', () => {
    // 3 x $189.37 x 1301.3 = 739,281.543 -> 739,282; fee 0.1% = 739.282 -> 739.
    expect(tradeCost('KRW', 'BUY', 3, 189.37, 0.001, 0, 1301.3)).toEqual({ amount: 739_282, fee: 739, tax: 0, cash: 740_021 });
    expect(tradeCost('KRW', 'SELL', 3, 189.37, 0.001, 0, 1298.7)).toEqual({ amount: 737_804, fee: 738, tax: 0, cash: 737_066 });
    expect(appliedFx(1300, 'BUY', 0.001)).toBe(1301.3);
    expect(appliedFx(1300, 'SELL', 0.001)).toBe(1298.7);
  });

  it('halves decision frequency and allows 1.5x orders per unified day in ALL leagues', () => {
    expect(typeDefaultsFor('3d', 'ALL')).toEqual({ trading_days: 3, decision_interval_min: 60, max_orders_per_day: 30 });
    expect(typeDefaultsFor('1w', 'ALL')).toEqual({ trading_days: 5, decision_interval_min: 120, max_orders_per_day: 15 });
    expect(typeDefaultsFor('1m', 'ALL')).toEqual({ trading_days: 20, decision_interval_min: 360, max_orders_per_day: 8 });
    expect(typeDefaultsFor('custom', 'ALL')).toEqual({ trading_days: null, decision_interval_min: 120, max_orders_per_day: 15 });
    expect(typeDefaultsFor('1w', 'KR')).toEqual(TYPE_DEFAULTS['1w']);
  });
});
