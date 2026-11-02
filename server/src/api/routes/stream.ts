import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StreamEvent } from '../../../../shared/api-types';
import { getParticipantRow } from '../../engine/store';
import { bus, type BusListener } from '../../lib/bus';
import { requireUser } from '../auth';
import { ApiHttpError } from '../errors';
import { loadVisibleLeague } from './leagues';

export const HEARTBEAT_MS = 20_000;
/** Open streams per user; a few browser tabs are fine, thousands are not. */
export const MAX_STREAMS_PER_USER = 5;

const StreamQuery = z.object({ league_id: z.coerce.number('league_id가 필요합니다.').int().positive() });

export interface StreamRouteOptions {
  /** Open streams register their closer here so the app can end them on shutdown. */
  streams: Set<() => void>;
}

/**
 * GET /stream?league_id= — Server-Sent Events for one league: quotes of the league's
 * market (ALL leagues: every quote, plus USD/KRW `fx` events), plus rankings, decisions and
 * orders of that league. Order events are sent only
 * for the viewer's own participant and AI participants, the same rule as GET /orders.
 */
export async function streamRoutes(app: FastifyInstance, opts: StreamRouteOptions): Promise<void> {
  const openPerUser = new Map<number, number>();

  app.get('/stream', async (req, reply) => {
    const user = requireUser(req);
    const { league_id: leagueId } = StreamQuery.parse(req.query);
    const league = loadVisibleLeague(user, leagueId);
    const open = openPerUser.get(user.id) ?? 0;
    if (open >= MAX_STREAMS_PER_USER) {
      throw new ApiHttpError(429, 'too_many_streams', '실시간 연결이 너무 많습니다. 다른 탭을 닫고 다시 시도해 주세요.');
    }
    openPerUser.set(user.id, open + 1);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    const send = (event: StreamEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const onQuotes: BusListener<'quotes'> = (quotes) => {
      const mine = league.market === 'ALL' ? quotes : quotes.filter((q) => q.market === league.market);
      if (mine.length > 0) send({ type: 'quotes', quotes: mine });
    };
    const onFx: BusListener<'fx'> = (fx) => {
      if (league.market === 'ALL') send({ type: 'fx', fx });
    };
    const onRankings: BusListener<'rankings'> = (e) => {
      if (e.league_id === leagueId) send({ type: 'rankings', league_id: e.league_id, rankings: e.rankings });
    };
    const onDecision: BusListener<'decision'> = (e) => {
      if (e.league_id === leagueId) send({ type: 'decision', ...e });
    };
    const onOrder: BusListener<'order'> = (e) => {
      if (e.league_id !== leagueId) return;
      const participant = getParticipantRow(e.participant_id);
      if (participant && (participant.agent_id !== null || participant.user_id === user.id)) {
        send({ type: 'order', league_id: e.league_id, participant_id: e.participant_id, order: e.order });
      }
    };

    bus.on('quotes', onQuotes);
    bus.on('fx', onFx);
    bus.on('rankings', onRankings);
    bus.on('decision', onDecision);
    bus.on('order', onOrder);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      bus.off('quotes', onQuotes);
      bus.off('fx', onFx);
      bus.off('rankings', onRankings);
      bus.off('decision', onDecision);
      bus.off('order', onOrder);
      opts.streams.delete(close);
      const left = (openPerUser.get(user.id) ?? 1) - 1;
      if (left > 0) openPerUser.set(user.id, left);
      else openPerUser.delete(user.id);
    };
    const close = () => {
      cleanup();
      if (!res.writableEnded) res.end();
    };
    opts.streams.add(close);
    res.on('close', cleanup);
    res.on('error', cleanup);
    // The client may have gone away (during the async preHandler) before these listeners existed.
    if (res.destroyed || req.raw.socket?.destroyed === true) cleanup();
  });
}
