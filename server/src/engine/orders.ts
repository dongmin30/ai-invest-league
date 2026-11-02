import type { Order, PlaceOrderRequest } from '../../../shared/api-types';
import { tx } from '../db/db';
import { bus } from '../lib/bus';
import { now } from '../lib/time';
import { isMarketOpen, leagueTradeDate, nextOpen } from '../market/calendar';
import { appliedFx, getFx } from '../market/fx';
import { getQuote } from '../market/quoteCache';
import { getSymbol } from '../market/symbols';
import { convertsFx, ratesFor, tradeCost } from './fees';
import { EngineError } from './errors';
import { availableCash, ordersOnDate } from './portfolio';
import { getHolding, getLeagueRow, getOrderRow, getParticipantRow, sql, toOrder, type OrderRow } from './store';

export { EngineError } from './errors';

function pendingQuantity(participantId: number, symbol: string, side: 'BUY' | 'SELL'): number {
  return sql(
    "SELECT COALESCE(SUM(quantity), 0) FROM orders WHERE participant_id = ? AND symbol = ? AND side = ? AND status = 'pending'",
  )
    .pluck()
    .get(participantId, symbol, side) as number;
}

/**
 * Validates and records an order as `pending`. A closed market is not an error: the order
 * waits for the first quote after placement while the market is open (see matcher.ts),
 * unless that market does not open again before the league ends (`session_after_end`).
 * In an ALL league, US symbols are valued at the USD/KRW mid and a BUY reserves cash at the
 * spread-applied rate (stored as ref_fx); with no rate at all the order is refused (`no_fx`).
 */
export function placeOrder(participantId: number, req: PlaceOrderRequest, source: 'user' | 'agent'): Order {
  const { order, leagueId } = tx(() => {
    const participant = getParticipantRow(participantId);
    const league = participant && getLeagueRow(participant.league_id);
    if (!participant || !league) throw new EngineError('not_found', '참가 정보를 찾을 수 없습니다.');
    if (participant.left_at !== null) {
      throw new EngineError('participant_left', '리그에서 나간 참가자는 주문할 수 없습니다.');
    }

    const at = now();
    if (league.status !== 'active' || at < league.start_at || at > league.end_at) {
      throw new EngineError('league_inactive', '진행 중인 리그에서만 주문할 수 있습니다.');
    }
    const info = getSymbol(req.symbol);
    if (!info || (league.market !== 'ALL' && info.market !== league.market)) {
      throw new EngineError('bad_symbol', '이 리그에서 거래할 수 없는 종목입니다.');
    }
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      throw new EngineError('bad_quantity', '수량은 1 이상의 정수여야 합니다.');
    }
    if (req.side !== 'BUY' && req.side !== 'SELL') {
      throw new EngineError('bad_side', '주문 방향이 올바르지 않습니다.');
    }
    if (req.type !== 'MARKET' && req.type !== 'LIMIT') {
      throw new EngineError('bad_type', '주문 유형이 올바르지 않습니다.');
    }
    const limitPrice = req.type === 'LIMIT' ? req.limit_price : undefined;
    if (req.type === 'LIMIT' && !(typeof limitPrice === 'number' && Number.isFinite(limitPrice) && limitPrice > 0)) {
      throw new EngineError('bad_limit', '지정가 주문에는 0보다 큰 가격이 필요합니다.');
    }
    const quote = getQuote(info.symbol);
    if (!quote) throw new EngineError('no_quote', '아직 시세가 없어 주문할 수 없습니다.');

    if (!isMarketOpen(info.market, at) && nextOpen(info.market, at) > league.end_at) {
      throw new EngineError('session_after_end', '리그 종료 전에 이 종목의 장이 열리지 않습니다.');
    }
    const fx = convertsFx(league.market, info.symbol) ? getFx(at) : undefined;
    if (fx === null) throw new EngineError('no_fx', '환율 정보가 아직 없어 미국 종목을 주문할 수 없습니다.');
    const refFx = fx ? (req.side === 'BUY' ? appliedFx(fx.rate, 'BUY', league.fx_spread) : fx.rate) : null;

    const tradeDate = leagueTradeDate(league.market, at);
    if (ordersOnDate(participantId, tradeDate) >= league.max_orders_per_day) {
      throw new EngineError('daily_limit', `오늘 주문 가능 횟수(${league.max_orders_per_day}회)를 모두 사용했습니다.`);
    }

    if (req.side === 'BUY') {
      const unitPrice = limitPrice ?? quote.price;
      const { fee_rate } = ratesFor(league, info.symbol);
      const cost = tradeCost(league.currency, 'BUY', req.quantity, unitPrice, fee_rate, 0, refFx ?? 1).cash;
      if (cost > availableCash(participantId)) {
        throw new EngineError('insufficient_cash', '주문 가능 금액이 부족합니다.');
      }
    } else {
      const heldQty = getHolding(participantId, info.symbol)?.quantity ?? 0;
      if (req.quantity > heldQty - pendingQuantity(participantId, info.symbol, 'SELL')) {
        throw new EngineError('insufficient_shares', '매도 가능 수량이 부족합니다.');
      }
    }

    const id = Number(
      sql(
        `INSERT INTO orders (participant_id, symbol, side, type, quantity, limit_price, ref_price, ref_fx, status, source, trade_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(
        participantId,
        info.symbol,
        req.side,
        req.type,
        req.quantity,
        limitPrice ?? null,
        quote.price,
        refFx,
        source,
        tradeDate,
        at,
      ).lastInsertRowid,
    );
    return { order: toOrder(getOrderRow(id)!), leagueId: league.id };
  });
  bus.emit('order', { league_id: leagueId, participant_id: participantId, order });
  return order;
}

export function cancelOrder(orderId: number, participantId: number): Order {
  const { order, leagueId } = tx(() => {
    const row = getOrderRow(orderId);
    if (!row || row.participant_id !== participantId) {
      throw new EngineError('not_found', '주문을 찾을 수 없습니다.');
    }
    if (row.status !== 'pending') throw new EngineError('not_pending', '대기 중인 주문만 취소할 수 있습니다.');
    sql("UPDATE orders SET status = 'canceled' WHERE id = ?").run(orderId);
    const participant = getParticipantRow(participantId)!;
    return { order: toOrder(getOrderRow(orderId)!), leagueId: participant.league_id };
  });
  bus.emit('order', { league_id: leagueId, participant_id: participantId, order });
  return order;
}

/** Newest first, at most `limit` orders. */
export function listOrders(participantId: number, status?: Order['status'], limit = 100): Order[] {
  const rows = (
    status
      ? sql('SELECT * FROM orders WHERE participant_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(
          participantId,
          status,
          limit,
        )
      : sql('SELECT * FROM orders WHERE participant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(
          participantId,
          limit,
        )
  ) as OrderRow[];
  return rows.map(toOrder);
}
