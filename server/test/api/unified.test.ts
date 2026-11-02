import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FxQuote, LeagueSummary, Order, Portfolio, StreamEvent, SymbolRow } from '../../../shared/api-types';
import { bus } from '../../src/lib/bus';
import { getFx } from '../../src/market/fx';
import { SYMBOLS } from '../../src/market/symbols';
import { feedMarket } from '../agents/fixtures';
import { HOUR, makeAgent, MIN, resetEngineState, restoreEngineState, setClock, setFxRate, US_OPEN } from '../engine/helpers';
import { expectApiError, register, testApp, type Session } from './helpers';

// API surface of 통합 (ALL) leagues.

let app: FastifyInstance;
let alice: Session;
let baseline: number;
let krOnly: number;

beforeEach(async () => {
  resetEngineState(US_OPEN + HOUR); // Monday 23:30 KST: US open, KR closed
  feedMarket('KR');
  feedMarket('US');
  baseline = makeAgent('기준선 봇', { model: 'baseline' });
  krOnly = makeAgent('국내 봇', { model: 'momentum', markets: 'KR' });
  app = await testApp();
  alice = await register(app, 'alice@example.com', '앨리스');
});

afterEach(async () => {
  await app.close();
  restoreEngineState();
});

function post(url: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, cookies: alice.cookies, payload });
}

function get(url: string) {
  return app.inject({ method: 'GET', url, cookies: alice.cookies });
}

const body = (extra: Record<string, unknown> = {}) => ({
  name: '통합 친구 리그',
  market: 'all',
  duration_days: 3,
  agent_ids: [baseline],
  is_public: true,
  start_now: true,
  ...extra,
});

describe('ALL leagues over the API', () => {
  it('creates, lists and trades a 통합 league in KRW', async () => {
    const res = await post('/api/leagues', body());
    expect(res.statusCode, res.body).toBe(200);
    const league = res.json<LeagueSummary>();
    expect(league).toMatchObject({
      market: 'ALL',
      currency: 'KRW',
      start_cash: 10_000_000,
      fx_spread: 0.001,
      decision_interval_min: 120,
      max_orders_per_day: 15,
      status: 'active',
      ai_count: 1,
    });
    await post('/api/leagues', { ...body({ market: 'KR', name: '국내 리그' }) });
    const listed = (await get('/api/leagues?market=ALL')).json<LeagueSummary[]>();
    expect(listed.map((l) => l.id)).toEqual([league.id]);

    const pid = league.my_participant_id!;
    expectApiError(await post(`/api/participants/${pid}/orders`, { symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }), 400, 'no_fx');
    setFxRate(1300);
    const placed = await post(`/api/participants/${pid}/orders`, { symbol: 'AAPL', side: 'BUY', type: 'LIMIT', quantity: 2, limit_price: 1_000 });
    expect(placed.statusCode, placed.body).toBe(200);
    expect(placed.json<Order>()).toMatchObject({ symbol: 'AAPL', status: 'pending', limit_price: 1_000, fx_rate: null });
    const portfolio = (await get(`/api/participants/${pid}/portfolio`)).json<Portfolio>();
    // Reserved in KRW at the spread-applied rate: 2 × $1,000 × 1301.3 = 2,602,600 + fee 2,603.
    expect(portfolio).toMatchObject({ currency: 'KRW', available_cash: 10_000_000 - 2_605_203, fx: { rate: 1300, stale: false } });
  });

  it('validates start cash in KRW and requires agents that trade both markets', async () => {
    expectApiError(await post('/api/leagues', body({ start_cash: 50_000 })), 400, 'validation');
    expectApiError(await post('/api/leagues', body({ agent_ids: [krOnly] })), 400, 'bad_agent');
    expectApiError(await post('/api/leagues', body({ market: 'JP' })), 400, 'validation');
  });

  it('serves both pools for ALL, keeps status per market, and returns USD/KRW', async () => {
    const rows = (await get('/api/market/ALL/symbols')).json<SymbolRow[]>();
    expect(rows).toHaveLength(SYMBOLS.length);
    expect(new Set(rows.map((r) => r.market))).toEqual(new Set(['KR', 'US']));
    expectApiError(await get('/api/market/ALL/status'), 400, 'validation');

    const empty = await get('/api/market/fx');
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toBeNull();
    setFxRate(1335.1);
    expect((await get('/api/market/fx')).json<FxQuote>()).toEqual({
      pair: 'USDKRW',
      rate: 1335.1,
      change_pct: 0,
      ts: US_OPEN + HOUR,
      source: 'sim',
      stale: false,
    });
    expectApiError(await app.inject({ method: 'GET', url: '/api/market/fx' }), 401, 'unauthorized');
  });

  it('streams quotes of both markets and fx events to ALL leagues only', async () => {
    const all = (await post('/api/leagues', body())).json<LeagueSummary>();
    const kr = (await post('/api/leagues', body({ market: 'KR', name: '국내' }))).json<LeagueSummary>();
    const open = async (leagueId: number) => {
      const res = await app.inject({ method: 'GET', url: `/api/stream?league_id=${leagueId}`, cookies: alice.cookies, payloadAsStream: true });
      expect(res.statusCode).toBe(200);
      let text = '';
      (res.stream() as Readable).on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      return () =>
        text
          .split('\n\n')
          .filter((b) => b.startsWith('data: '))
          .map((b) => JSON.parse(b.slice('data: '.length)) as StreamEvent);
    };
    const allEvents = await open(all.id);
    const krEvents = await open(kr.id);

    const [krQuote] = feedMarket('KR');
    const [usQuote] = feedMarket('US');
    bus.emit('quotes', [krQuote!, usQuote!]);
    setClock(US_OPEN + HOUR + MIN);
    setFxRate(1310);
    bus.emit('fx', getFx()!);
    await new Promise((resolve) => setImmediate(resolve));

    expect(allEvents()).toEqual([
      { type: 'quotes', quotes: [krQuote, usQuote] },
      { type: 'fx', fx: expect.objectContaining({ pair: 'USDKRW', rate: 1310 }) },
    ]);
    expect(krEvents()).toEqual([{ type: 'quotes', quotes: [krQuote] }]);
  });
});
