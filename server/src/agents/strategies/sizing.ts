import { getSymbol } from '../../market/symbols';
import type { DecisionInput } from '../types';

// Headroom against per-order rounding of amount and fee in the engine.
const SAFETY = 0.995;

/**
 * Tracks what rule strategies may still spend within one decision so every order they
 * emit passes placeOrder: available cash (fees included), the per-symbol position cap
 * (held + pending BUY quantity) and the remaining daily order count. Prices passed in are in
 * the league currency (ALL leagues: `price_krw`); fees are the symbol market's, and US buys in
 * ALL leagues also pay the FX spread.
 */
export class OrderBudget {
  private cash: number;
  private ordersLeft: number;
  private readonly cap: number;
  private readonly rules: DecisionInput['rules'];
  private readonly unified: boolean;
  private readonly heldQty = new Map<string, number>();
  private readonly pendingSellQty = new Map<string, number>();

  constructor(input: DecisionInput) {
    const { portfolio, rules, pendingOrders } = input;
    this.cash = portfolio.available_cash;
    this.ordersLeft = Math.max(0, portfolio.max_orders_per_day - portfolio.orders_today);
    this.cap = rules.max_position_pct * portfolio.equity;
    this.rules = rules;
    this.unified = input.league.market === 'ALL';
    for (const h of portfolio.holdings) this.heldQty.set(h.symbol, h.quantity);
    for (const o of pendingOrders) {
      if (o.status !== 'pending') continue;
      const target = o.side === 'BUY' ? this.heldQty : this.pendingSellQty;
      target.set(o.symbol, (target.get(o.symbol) ?? 0) + o.quantity);
    }
  }

  get canOrder(): boolean {
    return this.ordersLeft > 0;
  }

  get availableCash(): number {
    return this.cash;
  }

  /** Held plus pending-buy quantity: what the position cap counts. */
  exposure(symbol: string): number {
    return this.heldQty.get(symbol) ?? 0;
  }

  /** Cash per unit of price a BUY costs: fee of the symbol's market, plus the FX spread for US symbols in ALL leagues. */
  private costFactor(symbol: string): number {
    const market = getSymbol(symbol)?.market;
    const fee = (market && this.rules.rates?.[market]?.fee_rate) ?? this.rules.fee_rate;
    const spread = this.unified && market === 'US' ? (this.rules.fx_spread ?? 0) : 0;
    return (1 + fee) * (1 + spread);
  }

  /** Largest whole quantity buyable for at most `budget` (before fees) at `price`; 0 if none. */
  buyQuantity(symbol: string, price: number, budget: number): number {
    if (!this.canOrder || !(price > 0)) return 0;
    const byBudget = Math.min(budget, (this.cash * SAFETY) / this.costFactor(symbol));
    const byCap = this.cap * SAFETY - this.exposure(symbol) * price;
    return Math.max(0, Math.floor(Math.min(byBudget, byCap) / price));
  }

  sellableQuantity(symbol: string, held: number): number {
    if (!this.canOrder) return 0;
    return Math.max(0, held - (this.pendingSellQty.get(symbol) ?? 0));
  }

  commitBuy(symbol: string, quantity: number, price: number): void {
    this.cash -= quantity * price * this.costFactor(symbol);
    this.heldQty.set(symbol, this.exposure(symbol) + quantity);
    this.ordersLeft--;
  }

  commitSell(symbol: string, quantity: number): void {
    this.pendingSellQty.set(symbol, (this.pendingSellQty.get(symbol) ?? 0) + quantity);
    this.ordersLeft--;
  }
}
