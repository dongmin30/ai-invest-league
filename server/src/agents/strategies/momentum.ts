import { MAX_DECISION_ORDERS, type Decision } from '../schema';
import type { DecisionInput, LLMProvider } from '../types';
import { leaguePrice } from './baseline';
import { OrderBudget } from './sizing';

export const MOMENTUM_STOP_PCT = -2;
export const MOMENTUM_ENTRY_PCT = 1;
export const MOMENTUM_MAX_BUYS = 2;
export const MOMENTUM_WEIGHT = 0.2;

const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;

/**
 * Sells every holding down more than 2% on the day, then buys up to two of the top
 * gainers above +1% that it does not already own, with at most 20% of equity each.
 * Stocks and plain (1×) ETFs qualify; leveraged and inverse ETFs are never bought, since
 * their daily moves are a multiple of an index rather than a trend signal of their own
 * (and they decay when held).
 * In ALL leagues only symbols whose market is open now are traded (a closed market's
 * change_pct is the last session's), and sizes use the KRW price.
 * At most MAX_DECISION_ORDERS orders per decision; remaining sells wait for the next one.
 */
export function decideMomentum(input: DecisionInput): Decision {
  const budget = new OrderBudget(input);
  const unified = input.league.market === 'ALL';
  const bySymbol = new Map(input.candidates.map((c) => [c.symbol, c]));
  const orders: Decision['orders'] = [];
  const sold: string[] = [];

  for (const h of input.portfolio.holdings) {
    if (orders.length >= MAX_DECISION_ORDERS) break;
    const c = bySymbol.get(h.symbol);
    const change = c?.change_pct;
    if (change === null || change === undefined || change >= MOMENTUM_STOP_PCT) continue;
    if (unified && !c?.market_open) continue;
    const quantity = budget.sellableQuantity(h.symbol, h.quantity);
    if (quantity < 1) continue;
    budget.commitSell(h.symbol, quantity);
    sold.push(h.symbol);
    orders.push({ symbol: h.symbol, side: 'SELL', quantity, reason: `전일 대비 ${signed(change)}로 손절 기준(${MOMENTUM_STOP_PCT}%) 이탈` });
  }

  const gainers = input.candidates
    .filter(
      (c): c is typeof c & { price: number; change_pct: number } =>
        c.price !== null &&
        c.price > 0 &&
        (leaguePrice(c) ?? 0) > 0 &&
        (!unified || c.market_open) &&
        c.change_pct !== null &&
        c.change_pct > MOMENTUM_ENTRY_PCT &&
        c.leverage === 1 &&
        budget.exposure(c.symbol) === 0,
    )
    .sort((a, b) => b.change_pct - a.change_pct || a.symbol.localeCompare(b.symbol))
    .slice(0, MOMENTUM_MAX_BUYS);

  const perBuy = input.portfolio.equity * MOMENTUM_WEIGHT;
  for (const c of gainers) {
    if (orders.length >= MAX_DECISION_ORDERS) break;
    const price = leaguePrice(c)!;
    const quantity = budget.buyQuantity(c.symbol, price, perBuy);
    if (quantity < 1) continue;
    budget.commitBuy(c.symbol, quantity, price);
    orders.push({ symbol: c.symbol, side: 'BUY', quantity, reason: `전일 대비 ${signed(c.change_pct)} 상승 추세 추종` });
  }

  const buys = orders.length - sold.length;
  const market_view =
    orders.length === 0
      ? `모멘텀: 손절(${MOMENTUM_STOP_PCT}% 미만) 또는 신규 진입(+${MOMENTUM_ENTRY_PCT}% 초과) 조건을 만족하는 종목이 없어 관망합니다.`
      : `모멘텀: 약세 종목 ${sold.length}건 매도, 강세 종목 ${buys}건 매수.`;
  return { market_view, orders };
}

export function createMomentumStrategy(): LLMProvider {
  return {
    async decide(input) {
      const decision = decideMomentum(input);
      return { decision, raw: JSON.stringify(decision) };
    },
  };
}
