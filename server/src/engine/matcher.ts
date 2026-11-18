import type { Order, Quote } from '../../../shared/api-types';
import { tx } from '../db/db';
import { bus } from '../lib/bus';
import { now } from '../lib/time';
import { closingPrintSession, isMarketTradable } from '../market/calendar';
import { appliedFx, getFx } from '../market/fx';
import { convertsFx, ratesFor, roundMoney, tradeCost } from './fees';
import { reservedCash } from './portfolio';
import { getHolding, getOrderRow, reservePrice, sql, toOrder, type LeagueRow, type OrderRow } from './store';

type PendingRow = OrderRow & {
  league_id: number;
  cash: number;
  market: LeagueRow['market'];
  currency: LeagueRow['currency'];
  fee_rate: number;
  tax_rate: number;
  fx_spread: number;
};

function crosses(order: OrderRow, price: number): boolean {
  if (order.type === 'MARKET' || order.limit_price === null) return true;
  return order.side === 'BUY' ? price <= order.limit_price : price >= order.limit_price;
}

function reject(order: OrderRow, reason: string): void {
  sql("UPDATE orders SET status = 'rejected', reject_reason = ? WHERE id = ?").run(reason, order.id);
}

/** The most shares (at most `max`) whose BUY cost including the fee fits in `free`. */
function affordableQuantity(
  currency: LeagueRow['currency'],
  price: number,
  feeRate: number,
  fx: number,
  free: number,
  max: number,
): number {
  const cash = (quantity: number) => tradeCost(currency, 'BUY', quantity, price, feeRate, 0, fx).cash;
  let quantity = Math.max(0, Math.min(max, Math.floor(free / (price * fx * (1 + feeRate)))));
  // Amount and fee are rounded per trade, so the estimate can be a share off either way.
  while (quantity > 0 && cash(quantity) > free) quantity--;
  while (quantity < max && cash(quantity + 1) <= free) quantity++;
  return quantity;
}

/** `fx`: spread-applied USD/KRW for US symbols in ALL leagues, null otherwise. */
function fill(order: PendingRow, quote: Quote, fx: number | null): void {
  const rates = ratesFor(order, order.symbol);
  let filledQty = order.quantity;
  let cost = tradeCost(order.currency, order.side, filledQty, quote.price, rates.fee_rate, rates.tax_rate, fx ?? 1);
  const holding = getHolding(order.participant_id, order.symbol);

  if (order.side === 'BUY') {
    // A fill may not spend cash other pending BUYs hold back, so available cash never goes
    // negative. A fill above this order's own reservation (a higher price or FX rate) that the
    // free cash does not cover is cut down to the shares it does cover (a "buy everything"
    // order would otherwise be lost to any uptick); it is rejected only when not even one fits.
    const own = tradeCost(order.currency, 'BUY', order.quantity, reservePrice(order), rates.fee_rate, 0, order.ref_fx ?? 1).cash;
    const reservedByOthers = roundMoney(order.currency, reservedCash(order.participant_id) - own);
    // Rounded like every cash amount, so an exactly affordable USD fill is not lost to float error.
    const free = roundMoney(order.currency, order.cash - reservedByOthers);
    if (cost.cash > free) {
      filledQty = affordableQuantity(order.currency, quote.price, rates.fee_rate, fx ?? 1, free, order.quantity);
      if (filledQty < 1) {
        reject(order, '체결 시점에 주문 가능 금액이 부족했습니다.');
        return;
      }
      cost = tradeCost(order.currency, 'BUY', filledQty, quote.price, rates.fee_rate, 0, fx ?? 1);
    }
    const heldQty = holding?.quantity ?? 0;
    const quantity = heldQty + filledQty;
    const heldNative = heldQty * (holding?.avg_price ?? 0);
    const boughtNative = filledQty * quote.price;
    const avgPrice = (heldNative + boughtNative) / quantity;
    // Cost-basis FX weighted by the native (USD) amount: (q0·p0·f0 + q·p·f) / (q0·p0 + q·p).
    const avgFx =
      fx === null ? 1 : (heldNative * (holding?.avg_fx ?? fx) + boughtNative * fx) / (heldNative + boughtNative);
    sql(
      `INSERT INTO holdings (participant_id, symbol, quantity, avg_price, avg_fx) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (participant_id, symbol) DO UPDATE SET quantity = excluded.quantity, avg_price = excluded.avg_price,
         avg_fx = excluded.avg_fx`,
    ).run(order.participant_id, order.symbol, quantity, avgPrice, avgFx);
    sql('UPDATE participants SET cash = ? WHERE id = ?').run(
      roundMoney(order.currency, order.cash - cost.cash),
      order.participant_id,
    );
  } else {
    if (!holding || holding.quantity < order.quantity) {
      reject(order, '체결 시점에 보유 수량이 부족했습니다.');
      return;
    }
    const remaining = holding.quantity - order.quantity;
    if (remaining === 0) {
      sql('DELETE FROM holdings WHERE participant_id = ? AND symbol = ?').run(order.participant_id, order.symbol);
    } else {
      sql('UPDATE holdings SET quantity = ? WHERE participant_id = ? AND symbol = ?').run(
        remaining,
        order.participant_id,
        order.symbol,
      );
    }
    sql('UPDATE participants SET cash = ? WHERE id = ?').run(
      roundMoney(order.currency, order.cash + cost.cash),
      order.participant_id,
    );
  }

  // A cut-down BUY keeps what was asked for in requested_quantity; quantity is what filled.
  sql(
    `UPDATE orders SET status = 'filled', quantity = ?, requested_quantity = ?, fill_price = ?, fee = ?, tax = ?,
       fx_rate = ?, filled_at = ? WHERE id = ?`,
  ).run(filledQty, filledQty < order.quantity ? order.quantity : null, quote.price, cost.fee, cost.tax, fx, quote.ts, order.id);
}

/**
 * Fills (or rejects on re-check) pending orders against `quotes`. A BUY whose cost at the fill
 * price exceeds the free cash fills for the shares the cash covers (see `fill`). A quote is usable only if
 * it is newer than the order, its timestamp falls inside the tradable hours (regular session or
 * extended hours) and it is not
 * after the league's end_at (a league stays 'active' until the next status update).
 * A quote stamped within POST_CLOSE_FETCH_MS after a session close is that session's closing
 * print: it is treated as stamped at the close, so only orders placed by the close can fill
 * at it (also in a league whose end_at is that close).
 * US orders in ALL leagues convert at the current USD/KRW mid ± fx_spread; while the rate is
 * stale (or missing) they stay pending.
 * Orders are processed oldest first; each fill is its own transaction. Returns every order
 * it changed.
 */
export function matchOrders(quotes: Quote[]): Order[] {
  const latest = new Map<string, Quote>();
  for (const q of quotes) {
    const prev = latest.get(q.symbol);
    if (!prev || q.ts > prev.ts) latest.set(q.symbol, q);
  }

  const changed: { league_id: number; order: Order }[] = [];
  for (const quote of latest.values()) {
    const sessionTs =
      closingPrintSession(quote.market, quote.ts) ?? (isMarketTradable(quote.market, quote.ts) ? quote.ts : null);
    if (sessionTs === null) continue;
    const pending = sql(
      `SELECT o.*, p.league_id, l.market, l.currency, l.fee_rate, l.tax_rate, l.fx_spread
       FROM orders o
       JOIN participants p ON p.id = o.participant_id
       JOIN leagues l ON l.id = p.league_id
       WHERE o.status = 'pending' AND o.symbol = ? AND o.created_at < ? AND o.created_at <= ?
         AND l.status = 'active' AND l.market IN (?, 'ALL') AND l.end_at >= ?
       ORDER BY o.created_at, o.id`,
    ).all(quote.symbol, quote.ts, sessionTs, quote.market, sessionTs) as Omit<PendingRow, 'cash'>[];

    const mid = getFx(now());
    for (const candidate of pending) {
      if (!crosses(candidate, quote.price)) continue;
      let fx: number | null = null;
      if (convertsFx(candidate.market, candidate.symbol)) {
        if (!mid || mid.stale) continue; // waits for a fresh USD/KRW rate
        fx = appliedFx(mid.rate, candidate.side, candidate.fx_spread);
      }
      const order = tx(() => {
        // Re-read inside the transaction: an earlier fill may have changed cash or status.
        const fresh = getOrderRow(candidate.id);
        if (!fresh || fresh.status !== 'pending') return null;
        const cash = sql('SELECT cash FROM participants WHERE id = ?').pluck().get(fresh.participant_id) as number;
        fill({ ...candidate, ...fresh, cash }, quote, fx);
        return toOrder(getOrderRow(candidate.id)!);
      });
      if (order) changed.push({ league_id: candidate.league_id, order });
    }
  }

  for (const { league_id, order } of changed) {
    bus.emit('order', { league_id, participant_id: order.participant_id, order });
  }
  return changed.map((c) => c.order);
}
