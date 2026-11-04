import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeagueDetail, LeagueSummary, Order, StreamEvent } from '../../../shared/api-types';
import { buildApp } from '../../src/api/app';
import { MAX_STREAMS_PER_USER } from '../../src/api/routes/stream';
import { bus } from '../../src/lib/bus';
import { feedMarket } from '../agents/fixtures';
import { HOUR, KR_OPEN, makeAgent, resetEngineState, restoreEngineState } from '../engine/helpers';
import { expectApiError, register, testApp, type Session } from './helpers';

let app: FastifyInstance;

beforeEach(() => {
  resetEngineState(KR_OPEN + HOUR);
  feedMarket('KR');
});

afterEach(async () => {
  await app.close();
  restoreEngineState();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

function collect(stream: Readable): { text: () => string; events: () => StreamEvent[] } {
  let text = '';
  stream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  return {
    text: () => text,
    events: () =>
      text
        .split('\n\n')
        .filter((block) => block.startsWith('data: '))
        .map((block) => JSON.parse(block.slice('data: '.length)) as StreamEvent),
  };
}

function fakeOrder(participantId: number): Order {
  return {
    id: 1,
    participant_id: participantId,
    symbol: '005930',
    side: 'BUY',
    type: 'MARKET',
    quantity: 1,
    limit_price: null,
    status: 'pending',
    reject_reason: null,
    fill_price: null,
    fee: null,
    tax: null,
    fx_rate: null,
    created_at: KR_OPEN,
    filled_at: null,
    source: 'user',
  };
}

async function league(owner: Session, agentIds: number[] = []): Promise<LeagueSummary> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/leagues',
    cookies: owner.cookies,
    payload: { name: '스트림', market: 'KR', duration_days: 2, agent_ids: agentIds, is_public: true, start_now: true },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<LeagueSummary>();
}

describe('GET /api/stream', () => {
  it('streams league events as text/event-stream and filters by league and market', async () => {
    app = await testApp();
    const alice = await register(app, 'alice@example.com');
    const bob = await register(app, 'bob@example.com');
    const agentId = makeAgent('봇');
    const mine = await league(alice, [agentId]);
    const other = await league(alice);
    const bobPid = (
      await app.inject({ method: 'POST', url: `/api/leagues/${mine.id}/join`, cookies: bob.cookies, payload: {} })
    ).json<{ participant_id: number }>().participant_id;
    const detail = (await app.inject({ method: 'GET', url: `/api/leagues/${mine.id}`, cookies: alice.cookies })).json<LeagueDetail>();
    const aiPid = detail.rankings.find((r) => r.kind === 'ai')!.participant_id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/stream?league_id=${mine.id}`,
      cookies: alice.cookies,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    const stream = collect(res.stream());

    const [krQuote] = feedMarket('KR');
    const [usQuote] = feedMarket('US');
    bus.emit('quotes', [krQuote!, usQuote!]);
    bus.emit('rankings', { league_id: other.id, rankings: [] });
    bus.emit('rankings', { league_id: mine.id, rankings: [] });
    bus.emit('decision', { league_id: mine.id, agent_id: agentId, agent_name: '봇', status: 'hold', summary: '관망' });
    bus.emit('order', { league_id: mine.id, participant_id: mine.my_participant_id!, order: fakeOrder(mine.my_participant_id!) });
    bus.emit('order', { league_id: mine.id, participant_id: aiPid, order: fakeOrder(aiPid) });
    bus.emit('order', { league_id: mine.id, participant_id: bobPid, order: fakeOrder(bobPid) });
    bus.emit('order', { league_id: other.id, participant_id: other.my_participant_id!, order: fakeOrder(other.my_participant_id!) });
    await tick();

    // A ping first, so the browser can tell a live stream from one a proxy buffers.
    expect(stream.text().startsWith('retry: 5000\n\nevent: ping\ndata: {}\n\n')).toBe(true);
    const events = stream.events();
    expect(events.map((e) => e.type)).toEqual(['quotes', 'rankings', 'decision', 'order', 'order']);
    expect(events[0]).toEqual({ type: 'quotes', quotes: [krQuote] });
    expect(events[1]).toEqual({ type: 'rankings', league_id: mine.id, rankings: [] });
    expect(events[2]).toMatchObject({ type: 'decision', league_id: mine.id, agent_name: '봇', status: 'hold' });
    expect(events.slice(3).map((e) => (e.type === 'order' ? e.participant_id : null))).toEqual([mine.my_participant_id, aiPid]);

    // Closing the app ends the stream and unsubscribes it.
    await app.close();
    const before = stream.text();
    bus.emit('rankings', { league_id: mine.id, rankings: [] });
    await tick();
    expect(stream.text()).toBe(before);
  });

  it('limits open streams per user and frees a slot when a client disconnects', async () => {
    app = await testApp();
    const alice = await register(app, 'alice@example.com');
    const bob = await register(app, 'bob@example.com');
    const mine = await league(alice);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controllers: AbortController[] = [];
    const open = async (session: Session) => {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await fetch(`${address}/api/stream?league_id=${mine.id}`, {
        headers: { cookie: `token=${session.cookies.token}` },
        signal: controller.signal,
      });
      return { res, controller };
    };

    try {
      const streams = [];
      for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
        const opened = await open(alice);
        expect(opened.res.status).toBe(200);
        streams.push(opened);
      }
      const refused = await open(alice);
      expect(refused.res.status).toBe(429);
      expect(await refused.res.json()).toMatchObject({ error: 'too_many_streams' });
      expect((await open(bob)).res.status).toBe(200);

      streams[0]!.controller.abort();
      await vi.waitFor(async () => {
        const again = await open(alice);
        if (again.res.status !== 200) await again.res.body?.cancel();
        expect(again.res.status).toBe(200);
      });
    } finally {
      for (const c of controllers) c.abort();
    }
  });

  it('validates the league', async () => {
    app = await testApp();
    const alice = await register(app, 'alice@example.com');
    expectApiError(await app.inject({ method: 'GET', url: '/api/stream?league_id=999', cookies: alice.cookies }), 404, 'not_found');
    expectApiError(await app.inject({ method: 'GET', url: '/api/stream', cookies: alice.cookies }), 400, 'validation');
  });
});

describe('web app serving', () => {
  it('serves web/dist files with an SPA fallback, never for /api', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ail-web-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    try {
      app = await buildApp({ webDistDir: dir });

      const home = await app.inject({ method: 'GET', url: '/' });
      expect(home.statusCode).toBe(200);
      expect(home.headers['content-type']).toContain('text/html');

      const deep = await app.inject({ method: 'GET', url: '/leagues/3/trade' });
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toContain('id="root"');

      const js = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(js.statusCode).toBe(200);
      expect(js.headers['content-type']).toContain('javascript');

      expectApiError(await app.inject({ method: 'GET', url: '/assets/missing.js' }), 404, 'not_found');
      expectApiError(await app.inject({ method: 'GET', url: '/api/unknown' }), 404, 'not_found');
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ ok: true });
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
