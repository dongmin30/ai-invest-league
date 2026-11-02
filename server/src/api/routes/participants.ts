import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { User } from '../../../../shared/api-types';
import { cancelOrder, listOrders, placeOrder } from '../../engine/orders';
import { getPortfolio } from '../../engine/portfolio';
import { getOrderRow, getParticipantRow, type ParticipantRow } from '../../engine/store';
import { requireUser } from '../auth';
import { forbidden, notFound } from '../errors';
import { IdParams, OrderStatusSchema, optionalQuery } from '../validation';
import { loadVisibleLeague } from './leagues';

const ORDERS_LIMIT = 100;

const OrdersQuery = z.object({ status: optionalQuery(OrderStatusSchema) });

const PlaceOrderBody = z
  .object({
    symbol: z.string('종목을 선택해 주세요.').trim().toUpperCase().min(1, '종목을 선택해 주세요.').max(20),
    side: z.enum(['BUY', 'SELL'], '주문 방향은 BUY 또는 SELL이어야 합니다.'),
    type: z.enum(['MARKET', 'LIMIT'], '주문 유형은 MARKET 또는 LIMIT이어야 합니다.'),
    quantity: z.number('수량을 입력해 주세요.').int('수량은 1 이상의 정수여야 합니다.').min(1, '수량은 1 이상의 정수여야 합니다.'),
    limit_price: z.number().positive('지정가는 0보다 커야 합니다.').optional(),
  })
  .refine((o) => o.type === 'MARKET' || o.limit_price !== undefined, {
    path: ['limit_price'],
    message: '지정가 주문에는 가격이 필요합니다.',
  });

function loadParticipant(id: number): ParticipantRow {
  const participant = getParticipantRow(id);
  if (!participant) throw notFound('참가 정보를 찾을 수 없습니다.');
  return participant;
}

/** Portfolios and orders are visible to their owner and, for AI participants, to everyone who can see the league. */
function assertReadable(user: User, participant: ParticipantRow): void {
  if (participant.user_id === user.id) return;
  if (participant.agent_id !== null) {
    loadVisibleLeague(user, participant.league_id);
    return;
  }
  throw forbidden('다른 참가자의 정보는 볼 수 없습니다.');
}

function assertOwner(user: User, participant: ParticipantRow): void {
  if (participant.user_id !== user.id) throw forbidden('본인의 계좌에서만 주문할 수 있습니다.');
}

export async function participantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/participants/:id/portfolio', async (req) => {
    const user = requireUser(req);
    const participant = loadParticipant(IdParams.parse(req.params).id);
    assertReadable(user, participant);
    return getPortfolio(participant.id);
  });

  app.get('/participants/:id/orders', async (req) => {
    const user = requireUser(req);
    const participant = loadParticipant(IdParams.parse(req.params).id);
    assertReadable(user, participant);
    const { status } = OrdersQuery.parse(req.query);
    return listOrders(participant.id, status, ORDERS_LIMIT);
  });

  app.post('/participants/:id/orders', async (req) => {
    const user = requireUser(req);
    const participant = loadParticipant(IdParams.parse(req.params).id);
    assertOwner(user, participant);
    const body = PlaceOrderBody.parse(req.body);
    return placeOrder(
      participant.id,
      {
        symbol: body.symbol,
        side: body.side,
        type: body.type,
        quantity: body.quantity,
        ...(body.type === 'LIMIT' ? { limit_price: body.limit_price } : {}),
      },
      'user',
    );
  });

  app.delete('/orders/:id', async (req) => {
    const user = requireUser(req);
    const order = getOrderRow(IdParams.parse(req.params).id);
    if (!order) throw notFound('주문을 찾을 수 없습니다.');
    const participant = loadParticipant(order.participant_id);
    if (participant.user_id !== user.id) throw forbidden('본인의 주문만 취소할 수 있습니다.');
    return cancelOrder(order.id, participant.id);
  });
}
