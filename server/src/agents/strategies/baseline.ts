import { MAX_DECISION_ORDERS, type Decision } from '../schema';
import type { CandidateRow, DecisionInput, LLMProvider } from '../types';
import { OrderBudget } from './sizing';

export const BASELINE_NAMES = 10;
export const BASELINE_INVEST_FRACTION = 0.95;

function priced(c: CandidateRow): c is CandidateRow & { price: number } {
  return c.price !== null && c.price > 0;
}

/** Price in the league currency: `price_krw` in ALL leagues (US symbols at the USD/KRW mid), else `price`. */
export function leaguePrice(c: CandidateRow): number | null {
  return c.price_krw !== undefined ? c.price_krw : c.price;
}

interface Target {
  c: CandidateRow;
  price: number;
  reason: string;
}

/**
 * Single-market leagues: the 10 highest-volume stocks. ALL leagues: 5 KR + 5 US stocks by
 * traded value in KRW among those whose share price fits one equal-weight slot (`perName`;
 * top traded-value names are often > 950,000원 a share), only from markets open now (the other
 * half is bought when its market opens).
 */
function baselineTargets(input: DecisionInput, perName: number): Target[] {
  const stocks = input.candidates.filter((c) => c.kind === 'stock').filter(priced);
  if (input.league.market !== 'ALL') {
    return stocks
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0) || a.symbol.localeCompare(b.symbol))
      .slice(0, BASELINE_NAMES)
      .map((c, i) => ({ c, price: c.price, reason: `거래량 상위 ${i + 1}위 · 동일 비중 매수` }));
  }
  const perMarket = BASELINE_NAMES / 2;
  return (['KR', 'US'] as const).flatMap((market) =>
    stocks
      .flatMap((c) => {
        const price = leaguePrice(c);
        return c.market === market && c.market_open && price !== null && price > 0 && price <= perName ? [{ c, price }] : [];
      })
      .sort((a, b) => b.price * (b.c.volume ?? 0) - a.price * (a.c.volume ?? 0) || a.c.symbol.localeCompare(b.c.symbol))
      .slice(0, perMarket)
      .map((t, i) => ({ ...t, reason: `${market === 'KR' ? '한국' : '미국'} 거래대금 상위 ${i + 1}위 · 동일 비중 매수` })),
  );
}

/**
 * Buy-and-hold benchmark: equal weight across the 10 highest-volume stock candidates with
 * ~95% of equity, then hold (ALL leagues: 5 KR + 5 US, see baselineTargets). ETFs (plain, leveraged or inverse) are never bought, so the
 * benchmark stays a diversified stock portfolio. A decision carries at most MAX_DECISION_ORDERS orders, so the
 * initial build spans two decisions; the daily order limit or an unaffordable share can
 * split it further. Once the target is reached it never trades.
 */
export function decideBaseline(input: DecisionInput): Decision {
  const budget = new OrderBudget(input);
  const equity = input.portfolio.equity;

  const owned = input.candidates.filter((c) => c.kind === 'stock' && budget.exposure(c.symbol) > 0);
  const ownedCount = owned.length;
  // ALL leagues: at most half of the names per market, so the other market's half stays funded.
  const perMarketCap = input.league.market === 'ALL' ? BASELINE_NAMES / 2 : BASELINE_NAMES;
  const ownedIn = (market: string) => owned.filter((c) => c.market === market).length;
  const added = new Map<string, number>();
  const perName = (equity * BASELINE_INVEST_FRACTION) / BASELINE_NAMES;
  const targets = baselineTargets(input, perName);
  let spendable = budget.availableCash - equity * (1 - BASELINE_INVEST_FRACTION);

  const orders: Decision['orders'] = [];
  if (ownedCount < BASELINE_NAMES && spendable >= perName / 2) {
    for (const { c, price, reason } of targets) {
      if (orders.length >= MAX_DECISION_ORDERS || budget.exposure(c.symbol) > 0 || spendable <= 0) continue;
      if (input.league.market === 'ALL' && ownedIn(c.market) + (added.get(c.market) ?? 0) >= perMarketCap) continue;
      const quantity = budget.buyQuantity(c.symbol, price, Math.min(perName, spendable));
      if (quantity < 1) continue;
      budget.commitBuy(c.symbol, quantity, price);
      spendable -= quantity * price;
      added.set(c.market, (added.get(c.market) ?? 0) + 1);
      orders.push({ symbol: c.symbol, side: 'BUY', quantity, reason });
    }
  }

  if (orders.length > 0) {
    const universe =
      input.league.market === 'ALL'
        ? `한국·미국 거래대금 상위 각 ${BASELINE_NAMES / 2}개`
        : `거래량 상위 ${BASELINE_NAMES}개`;
    return { market_view: `기준선: ${universe} 주식에 자산의 약 95%를 동일 비중으로 투자합니다.`, orders };
  }
  return { market_view: '기준선: 초기 포트폴리오를 그대로 보유합니다.', orders: [] };
}

export function createBaselineStrategy(): LLMProvider {
  return {
    async decide(input) {
      const decision = decideBaseline(input);
      return { decision, raw: JSON.stringify(decision) };
    },
  };
}
