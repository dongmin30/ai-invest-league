import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDetail,
  DashboardCard,
  DecisionLog,
  EquitySeries,
  LeagueDetail,
  LeagueSummary,
  MarketStatus,
  Order,
  Portfolio,
  SymbolRow,
  User,
} from '../../../shared/api-types';
import { setProviderResolver } from '../../src/agents/runner';
import { MAX_OPEN_OWNED_LEAGUES } from '../../src/api/routes/leagues';
import { config } from '../../src/config';
import { db } from '../../src/db/db';
import { matchOrders } from '../../src/engine/matcher';
import { storeQuotes, type Collector } from '../../src/market/collector';
import { symbolsFor } from '../../src/market/symbols';
import { feedMarket } from '../agents/fixtures';
import { clockNow, HOUR, KR_OPEN, makeAgent, MIN, resetEngineState, restoreEngineState, setClock } from '../engine/helpers';
import { expectApiError, register, sessionCookie, testApp, type Session } from './helpers';

let app: FastifyInstance;
let admin: Session;
let alice: Session;
let bob: Session;
let agents: { baseline: number; momentum: number; claude: number };
let collectorTicks = 0;

const collector: Collector = {
  async tick() {
    collectorTicks++;
    return feedMarket('KR');
  },
  async loadDailyBars() {},
};

beforeEach(async () => {
  resetEngineState(KR_OPEN + HOUR);
  feedMarket('KR');
  feedMarket('US');
  collectorTicks = 0;
  agents = {
    baseline: makeAgent('기준선 봇', { model: 'baseline' }),
    momentum: makeAgent('모멘텀 봇', { model: 'momentum' }),
    claude: makeAgent('Claude 트레이더', { provider: 'claude', model: 'claude-opus-5-5', enabled: false }),
  };
  app = await testApp(collector);
  admin = await register(app, 'admin@example.com', '관리자');
  alice = await register(app, 'alice@example.com', '앨리스');
  bob = await register(app, 'bob@example.com', '바비');
});

afterEach(async () => {
  await app.close();
  restoreEngineState();
});

async function createLeague(session: Session, body: Record<string, unknown> = {}): Promise<LeagueSummary> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/leagues',
    cookies: session.cookies,
    payload: {
      name: '친구 리그',
      market: 'KR',
      duration_days: 3,
      agent_ids: [agents.baseline, agents.momentum],
      is_public: true,
      start_now: true,
      ...body,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<LeagueSummary>();
}

async function join(session: Session, leagueId: number, inviteCode?: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/leagues/${leagueId}/join`,
    cookies: session.cookies,
    payload: inviteCode === undefined ? {} : { invite_code: inviteCode },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ participant_id: number }>().participant_id;
}

function order(session: Session, participantId: number, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/participants/${participantId}/orders`, cookies: session.cookies, payload });
}

function get(session: Session | null, url: string) {
  return app.inject({ method: 'GET', url, cookies: session?.cookies });
}

describe('protected endpoints', () => {
  it('return 401 without a session', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/me/dashboard'],
      ['GET', '/api/leagues'],
      ['POST', '/api/leagues'],
      ['POST', '/api/leagues/1/join'],
      ['POST', '/api/leagues/join-by-code'],
      ['POST', '/api/leagues/1/leave'],
      ['GET', '/api/leagues/1/invite'],
      ['GET', '/api/leagues/1'],
      ['GET', '/api/leagues/1/equity'],
      ['GET', '/api/participants/1/portfolio'],
      ['GET', '/api/participants/1/orders'],
      ['POST', '/api/participants/1/orders'],
      ['DELETE', '/api/orders/1'],
      ['GET', '/api/market/KR/symbols'],
      ['GET', '/api/market/KR/status'],
      ['GET', '/api/market/quote/005930/intraday'],
      ['GET', '/api/agents'],
      ['GET', '/api/agents/1'],
      ['POST', '/api/admin/agents/1/run'],
      ['POST', '/api/admin/collect'],
      ['GET', '/api/stream?league_id=1'],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as 'GET', url, payload: method === 'POST' ? {} : undefined });
      expectApiError(res, 401, 'unauthorized');
    }
  });
});

describe('custom leagues', () => {
  it('creates a start_now league with rule agents, owner auto-joined', async () => {
    const league = await createLeague(alice);
    expect(league).toMatchObject({
      name: '친구 리그',
      type: 'custom',
      market: 'KR',
      currency: 'KRW',
      status: 'active',
      start_at: KR_OPEN + HOUR,
      start_cash: 10_000_000,
      participant_count: 3,
      ai_count: 2,
      is_public: true,
      joined: true,
    });
    expect(league.my_participant_id).toEqual(expect.any(Number));
    expect(league.end_at).toBeGreaterThan(league.start_at);
  });

  it('starts at the next open unless start_now', async () => {
    const league = await createLeague(alice, { start_now: false, market: 'US', start_cash: 5_000 });
    expect(league).toMatchObject({ status: 'recruiting', currency: 'USD', start_cash: 5_000 });
    expect(league.start_at).toBeGreaterThan(clockNow());
  });

  it('rejects disabled agents, bad durations and out-of-range cash', async () => {
    const base = { name: 'x', market: 'KR', is_public: true, start_now: true };
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/leagues', cookies: alice.cookies, payload });

    expectApiError(await post({ ...base, duration_days: 3, agent_ids: [agents.claude] }), 400, 'agent_disabled');
    expectApiError(await post({ ...base, duration_days: 3, agent_ids: [9999] }), 400, 'bad_agent');
    const days = expectApiError(await post({ ...base, duration_days: 0, agent_ids: [] }), 400, 'validation');
    expect(days.message).toBe('리그 기간은 1~20 거래일이어야 합니다.');
    expectApiError(await post({ ...base, duration_days: 21, agent_ids: [] }), 400, 'validation');
    expectApiError(await post({ ...base, duration_days: 3, agent_ids: [], start_cash: 10 }), 400, 'validation');
    expectApiError(await post({ ...base, name: '', duration_days: 3, agent_ids: [] }), 400, 'validation');
  });

  it('lists public leagues and joined private ones, with filters', async () => {
    const pub = await createLeague(alice);
    const priv = await createLeague(alice, { is_public: false, name: '비공개' });
    const us = await createLeague(bob, { market: 'US', agent_ids: [] });

    const forBob = (await get(bob, '/api/leagues')).json<LeagueSummary[]>().map((l) => l.id);
    expect(forBob).toContain(pub.id);
    expect(forBob).toContain(us.id);
    expect(forBob).not.toContain(priv.id);

    const forAlice = (await get(alice, '/api/leagues?status=&market=')).json<LeagueSummary[]>().map((l) => l.id);
    expect(forAlice).toContain(priv.id);

    const kr = (await get(alice, '/api/leagues?status=active&market=KR')).json<LeagueSummary[]>();
    expect(kr.map((l) => l.id).sort()).toEqual([pub.id, priv.id].sort());
    expect((await get(alice, '/api/leagues?status=finished')).json()).toEqual([]);
    expectApiError(await get(alice, '/api/leagues?status=bogus'), 400, 'validation');
  });

  it('joins once, and needs the invite code for private leagues', async () => {
    const league = await createLeague(alice);
    const pid = await join(bob, league.id);
    expect(pid).toEqual(expect.any(Number));

    const again = await app.inject({ method: 'POST', url: `/api/leagues/${league.id}/join`, cookies: bob.cookies });
    expectApiError(again, 400, 'already_joined');
    expectApiError(
      await app.inject({ method: 'POST', url: '/api/leagues/9999/join', cookies: bob.cookies, payload: {} }),
      404,
      'not_found',
    );

    const priv = await createLeague(alice, { is_public: false });
    const noCode = await app.inject({ method: 'POST', url: `/api/leagues/${priv.id}/join`, cookies: bob.cookies, payload: {} });
    expectApiError(noCode, 404, 'not_found');
  });

  it('join by id hides a private league from outsiders unless a well-formed invite code is sent', async () => {
    const priv = await createLeague(alice, { is_public: false });
    const closed = await createLeague(alice, { is_public: false });
    db.prepare("UPDATE leagues SET status = 'finished' WHERE id = ?").run(closed.id);
    const code = (await get(alice, `/api/leagues/${priv.id}/invite`)).json<{ invite_code: string }>().invite_code;
    const codes = db.prepare('SELECT invite_code FROM leagues').pluck().all();
    const wrong = ['ZZZZZZ', 'YYYYYY', 'XXXXXX'].find((c) => !codes.includes(c))!;
    const joinById = (session: Session, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/leagues/${priv.id}/join`, cookies: session.cookies, payload });

    // No code or a malformed one: indistinguishable from a league that does not exist.
    expectApiError(await joinById(bob, {}), 404, 'not_found');
    expectApiError(await joinById(bob, { invite_code: '' }), 404, 'not_found');
    expectApiError(await joinById(bob, { invite_code: 'ABC' }), 404, 'not_found');
    expectApiError(await joinById(bob, { invite_code: 'AB-CD!' }), 404, 'not_found');
    // A well-formed but wrong code.
    expectApiError(await joinById(bob, { invite_code: wrong }), 400, 'bad_invite');

    // A finished private league still says nothing beyond 404 / bad_invite to outsiders.
    const closedJoin = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/leagues/${closed.id}/join`, cookies: bob.cookies, payload });
    expectApiError(await closedJoin({}), 404, 'not_found');
    expectApiError(await closedJoin({ invite_code: wrong }), 400, 'bad_invite');

    // The right code (any case) joins; afterwards the league is visible, so errors are explicit.
    const res = await joinById(bob, { invite_code: code.toLowerCase() });
    expect(res.statusCode, res.body).toBe(200);
    expectApiError(await joinById(bob, {}), 400, 'already_joined');
  });

  it('returns league detail, equity and dashboard', async () => {
    const league = await createLeague(alice);
    const bobPid = await join(bob, league.id);

    const detail = (await get(bob, `/api/leagues/${league.id}`)).json<LeagueDetail>();
    expect(detail.league).toMatchObject({ id: league.id, joined: true, my_participant_id: bobPid, participant_count: 4 });
    expect(detail.rankings).toHaveLength(4);
    expect(detail.rankings.filter((r) => r.kind === 'ai').map((r) => r.model).sort()).toEqual(['baseline', 'momentum']);
    expect(detail).toMatchObject({ human_avg_return: 0, ai_avg_return: null, baseline_return: 0 });

    const equity = (await get(bob, `/api/leagues/${league.id}/equity`)).json<EquitySeries[]>();
    expect(equity.map((s) => s.participant_id)).toContain(bobPid);

    const cards = (await get(bob, '/api/me/dashboard')).json<DashboardCard[]>();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.league.id).toBe(league.id);

    expectApiError(await get(bob, '/api/leagues/9999'), 404, 'not_found');
    expectApiError(await get(bob, '/api/leagues/abc'), 400, 'validation');
  });
});

describe('custom league limits', () => {
  it('lets only admins invite LLM agents', async () => {
    const llm = makeAgent('로컬 LLM', { provider: 'ollama', model: 'qwen3:8b' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/leagues',
      cookies: alice.cookies,
      payload: { name: 'LLM', market: 'KR', duration_days: 3, agent_ids: [llm], is_public: true, start_now: true },
    });
    expectApiError(res, 403, 'forbidden');
    const league = await createLeague(admin, { agent_ids: [llm, agents.baseline] });
    expect(league.ai_count).toBe(2);
  });

  it('caps unfinished custom leagues per owner, except for admins', async () => {
    for (let i = 0; i < MAX_OPEN_OWNED_LEAGUES; i++) await createLeague(alice, { name: `리그 ${i}` });
    const res = await app.inject({
      method: 'POST',
      url: '/api/leagues',
      cookies: alice.cookies,
      payload: { name: '하나 더', market: 'KR', duration_days: 3, agent_ids: [], is_public: true, start_now: true },
    });
    expectApiError(res, 400, 'league_limit');
    await createLeague(bob);
    for (let i = 0; i <= MAX_OPEN_OWNED_LEAGUES; i++) await createLeague(admin, { name: `관리자 ${i}` });
  });

  it('rate-limits league creation per IP', async () => {
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/leagues',
        cookies: admin.cookies,
        payload: { name: '연속', market: 'KR', duration_days: 1, agent_ids: [], is_public: true, start_now: true },
      });
    for (let i = 0; i < 10; i++) expect((await post()).statusCode).toBe(200);
    expectApiError(await post(), 429, 'rate_limited');
  });
});

describe('private league visibility', () => {
  it('hides a private league, its equity, AI portfolios and agent participations from non-members', async () => {
    const priv = await createLeague(alice, { is_public: false, name: '비밀 리그' });
    const detail = (await get(alice, `/api/leagues/${priv.id}`)).json<LeagueDetail>();
    const aiPid = detail.rankings.find((r) => r.kind === 'ai')!.participant_id;

    expectApiError(await get(bob, `/api/leagues/${priv.id}`), 404, 'not_found');
    expectApiError(await get(bob, `/api/leagues/${priv.id}/equity`), 404, 'not_found');
    expectApiError(await get(bob, `/api/participants/${aiPid}/portfolio`), 404, 'not_found');
    expectApiError(await get(bob, `/api/participants/${aiPid}/orders`), 404, 'not_found');
    expectApiError(await get(bob, `/api/stream?league_id=${priv.id}`), 404, 'not_found');
    const agentForBob = (await get(bob, `/api/agents/${agents.baseline}`)).json<AgentDetail>();
    expect(agentForBob.participations.map((p) => p.league_id)).not.toContain(priv.id);

    expect((await get(alice, `/api/leagues/${priv.id}/equity`)).statusCode).toBe(200);
    expect((await get(alice, `/api/participants/${aiPid}/portfolio`)).statusCode).toBe(200);
    expect((await get(admin, `/api/leagues/${priv.id}`)).statusCode).toBe(200);
    const agentForAlice = (await get(alice, `/api/agents/${agents.baseline}`)).json<AgentDetail>();
    expect(agentForAlice.participations.map((p) => p.league_id)).toContain(priv.id);
  });
});

describe('private league invites', () => {
  it('shows the invite code to the owner and admins only, and lets an outsider join by code', async () => {
    const priv = await createLeague(alice, { is_public: false, name: '초대 리그' });
    const inviteOf = (session: Session) => get(session, `/api/leagues/${priv.id}/invite`);

    const { invite_code: code } = (await inviteOf(alice)).json<{ invite_code: string }>();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect((await inviteOf(admin)).json()).toEqual({ invite_code: code });
    expectApiError(await inviteOf(bob), 404, 'not_found');
    const pub = await createLeague(alice);
    expect((await get(alice, `/api/leagues/${pub.id}/invite`)).json()).toEqual({ invite_code: null });

    const joinByCode = (session: Session, invite_code: unknown) =>
      app.inject({ method: 'POST', url: '/api/leagues/join-by-code', cookies: session.cookies, payload: { invite_code } });
    expectApiError(await joinByCode(bob, 'ZZZZZZ'), 400, 'bad_invite');
    expectApiError(await joinByCode(bob, 'ABC'), 400, 'validation');

    const joined = await joinByCode(bob, code.toLowerCase());
    expect(joined.statusCode, joined.body).toBe(200);
    const { league_id, participant_id } = joined.json<{ league_id: number; participant_id: number }>();
    expect(league_id).toBe(priv.id);
    const detail = (await get(bob, `/api/leagues/${priv.id}`)).json<LeagueDetail>();
    expect(detail.league).toMatchObject({ joined: true, my_participant_id: participant_id });
    // Members other than the owner see the league but not the code.
    expectApiError(await inviteOf(bob), 403, 'forbidden');
    expectApiError(await joinByCode(bob, code), 400, 'already_joined');
  });

  it('rate-limits joins per IP so invite codes cannot be guessed', async () => {
    const post = () =>
      app.inject({ method: 'POST', url: '/api/leagues/join-by-code', cookies: bob.cookies, payload: { invite_code: 'ZZZZZZ' } });
    for (let i = 0; i < 20; i++) expectApiError(await post(), 400, 'bad_invite');
    expectApiError(await post(), 429, 'rate_limited');
  });
});

describe('leaving leagues', () => {
  const leave = (session: Session, leagueId: number) =>
    app.inject({ method: 'POST', url: `/api/leagues/${leagueId}/leave`, cookies: session.cookies });

  it('removes the participant of a recruiting league, who may join again', async () => {
    const league = await createLeague(alice, { start_now: false });
    expect(league.status).toBe('recruiting');
    await join(bob, league.id);

    const res = await leave(bob, league.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, forfeited: false });
    const detail = (await get(bob, `/api/leagues/${league.id}`)).json<LeagueDetail>();
    expect(detail.league).toMatchObject({ joined: false, my_participant_id: null, left: false, participant_count: 3 });
    expect((await get(bob, '/api/me/dashboard')).json<DashboardCard[]>()).toEqual([]);
    expectApiError(await leave(bob, league.id), 400, 'not_joined');
    await join(bob, league.id);
  });

  it('forfeits an active league: orders canceled and refused, out of the rankings, no rejoin', async () => {
    const league = await createLeague(alice);
    const pid = await join(bob, league.id);
    const pending = await order(bob, pid, { symbol: '005930', side: 'BUY', type: 'LIMIT', quantity: 1, limit_price: 1_000 });
    expect(pending.statusCode, pending.body).toBe(200);

    const res = await leave(bob, league.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, forfeited: true });

    const orders = (await get(bob, `/api/participants/${pid}/orders`)).json<Order[]>();
    expect(orders[0]).toMatchObject({ status: 'canceled', reject_reason: '리그에서 나가 취소되었습니다.' });
    expectApiError(await order(bob, pid, { symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 1 }), 400, 'participant_left');
    const detail = (await get(bob, `/api/leagues/${league.id}`)).json<LeagueDetail>();
    expect(detail.league).toMatchObject({ joined: false, my_participant_id: null, left: true, participant_count: 3 });
    expect(detail.rankings.map((r) => r.participant_id)).not.toContain(pid);
    expect((await get(bob, '/api/me/dashboard')).json<DashboardCard[]>()).toEqual([]);
    const rejoin = await app.inject({ method: 'POST', url: `/api/leagues/${league.id}/join`, cookies: bob.cookies, payload: {} });
    expectApiError(rejoin, 400, 'left_league');
    expectApiError(await leave(bob, league.id), 400, 'not_joined');
  });

  it('refuses finished leagues and hides private leagues from outsiders and from members who left', async () => {
    const finished = await createLeague(alice);
    db.prepare("UPDATE leagues SET status = 'finished' WHERE id = ?").run(finished.id);
    expectApiError(await leave(alice, finished.id), 400, 'league_finished');
    expectApiError(await leave(alice, 9999), 404, 'not_found');

    const priv = await createLeague(alice, { is_public: false });
    expectApiError(await leave(bob, priv.id), 404, 'not_found');
    const code = (await get(alice, `/api/leagues/${priv.id}/invite`)).json<{ invite_code: string }>().invite_code;
    await join(bob, priv.id, code);
    expect((await leave(bob, priv.id)).statusCode).toBe(200);
    expectApiError(await get(bob, `/api/leagues/${priv.id}`), 404, 'not_found');
    expectApiError(await leave(bob, priv.id), 404, 'not_found');
    const agentForBob = (await get(bob, `/api/agents/${agents.baseline}`)).json<AgentDetail>();
    expect(agentForBob.participations.map((p) => p.league_id)).not.toContain(priv.id);
  });

  it('frees an owner slot of the unfinished-league cap once the owner leaves', async () => {
    const owned: LeagueSummary[] = [];
    for (let i = 0; i < MAX_OPEN_OWNED_LEAGUES; i++) owned.push(await createLeague(alice, { name: `리그 ${i}` }));
    expect((await leave(alice, owned[0]!.id)).statusCode).toBe(200);
    // The owner keeps seeing (and owning) the league they left.
    expect((await get(alice, `/api/leagues/${owned[0]!.id}`)).json<LeagueDetail>().league).toMatchObject({ left: true });
    await createLeague(alice, { name: '새 리그' });
  });
});

describe('trading', () => {
  it('runs register → login cookie → join → order → fill → portfolio end to end', async () => {
    const league = await createLeague(alice);
    await register(app, 'carol@example.com', '캐롤', 'carol-pass-1');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'carol@example.com', password: 'carol-pass-1' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const carol: Session = { user: login.json<{ user: User }>().user, cookies: { token: sessionCookie(login) } };

    const pid = await join(carol, league.id);
    const placed = await order(carol, pid, { symbol: '000660', side: 'BUY', type: 'MARKET', quantity: 2 });
    expect(placed.statusCode, placed.body).toBe(200);
    expect((await get(carol, `/api/participants/${pid}/portfolio`)).json<Portfolio>().available_cash).toBeLessThan(10_000_000);

    setClock(clockNow() + MIN);
    const [filled] = matchOrders(feedMarket('KR', { '000660': { price: 60_000 } }));
    expect(filled).toMatchObject({ id: placed.json<Order>().id, status: 'filled', fill_price: 60_000 });

    const portfolio = (await get(carol, `/api/participants/${pid}/portfolio`)).json<Portfolio>();
    expect(portfolio.holdings).toEqual([expect.objectContaining({ symbol: '000660', quantity: 2, avg_price: 60_000, price: 60_000 })]);
    expect(portfolio.cash).toBe(10_000_000 - 120_000 - 18);
    expect(portfolio.available_cash).toBe(portfolio.cash);
    expect(portfolio.equity).toBe(10_000_000 - 18);
    const detail = (await get(carol, `/api/leagues/${league.id}`)).json<LeagueDetail>();
    expect(detail.rankings.find((r) => r.participant_id === pid)).toMatchObject({ eligible: true, trade_count: 1 });
  });

  it('places an order, fills it on a later quote, and shows the portfolio', async () => {
    const league = await createLeague(alice);
    const pid = await join(bob, league.id);

    const placed = await order(bob, pid, { symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 10 });
    expect(placed.statusCode, placed.body).toBe(200);
    expect(placed.json<Order>()).toMatchObject({ participant_id: pid, symbol: '005930', status: 'pending', source: 'user' });

    setClock(clockNow() + MIN);
    matchOrders(feedMarket('KR'));

    const portfolio = (await get(bob, `/api/participants/${pid}/portfolio`)).json<Portfolio>();
    expect(portfolio).toMatchObject({ participant_id: pid, league_id: league.id, currency: 'KRW', orders_today: 1 });
    expect(portfolio.holdings).toEqual([expect.objectContaining({ symbol: '005930', quantity: 10, avg_price: 50_000 })]);
    expect(portfolio.cash).toBe(10_000_000 - 500_000 - 75);

    const filled = (await get(bob, `/api/participants/${pid}/orders?status=filled`)).json<Order[]>();
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ status: 'filled', fill_price: 50_000, fee: 75 });
  });

  it('cancels a pending order and lists orders newest first', async () => {
    const league = await createLeague(alice);
    const pid = await join(bob, league.id);
    const first = (await order(bob, pid, { symbol: '000660', side: 'BUY', type: 'LIMIT', quantity: 1, limit_price: 1_000 })).json<Order>();
    setClock(clockNow() + 1);
    const second = (await order(bob, pid, { symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 1 })).json<Order>();

    const canceled = await app.inject({ method: 'DELETE', url: `/api/orders/${first.id}`, cookies: bob.cookies });
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json<Order>().status).toBe('canceled');
    expectApiError(
      await app.inject({ method: 'DELETE', url: `/api/orders/${first.id}`, cookies: bob.cookies }),
      400,
      'not_pending',
    );
    expectApiError(await app.inject({ method: 'DELETE', url: '/api/orders/9999', cookies: bob.cookies }), 404, 'not_found');

    const all = (await get(bob, `/api/participants/${pid}/orders`)).json<Order[]>();
    expect(all.map((o) => o.id)).toEqual([second.id, first.id]);
  });

  it('maps engine and validation errors to 400 ApiErrors', async () => {
    const league = await createLeague(alice);
    const pid = league.my_participant_id!;

    expectApiError(await order(alice, pid, { symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 1_000 }), 400, 'insufficient_cash');
    expectApiError(await order(alice, pid, { symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }), 400, 'bad_symbol');
    expectApiError(await order(alice, pid, { symbol: '005930', side: 'SELL', type: 'MARKET', quantity: 1 }), 400, 'insufficient_shares');
    const limit = expectApiError(await order(alice, pid, { symbol: '005930', side: 'BUY', type: 'LIMIT', quantity: 1 }), 400, 'validation');
    expect(limit.message).toBe('지정가 주문에는 가격이 필요합니다.');
    expectApiError(await order(alice, pid, { symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 1.5 }), 400, 'validation');
    expectApiError(await order(alice, pid, { symbol: '005930', side: 'HOLD', type: 'MARKET', quantity: 1 }), 400, 'validation');
  });

  it("forbids ordering on or reading someone else's participant, but allows reading AI participants", async () => {
    const league = await createLeague(alice);
    const alicePid = league.my_participant_id!;
    const bobPid = await join(bob, league.id);
    const bobOrder = (await order(bob, bobPid, { symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 1 })).json<Order>();

    expectApiError(await order(alice, bobPid, { symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 1 }), 403, 'forbidden');
    expectApiError(await get(alice, `/api/participants/${bobPid}/portfolio`), 403, 'forbidden');
    expectApiError(await get(alice, `/api/participants/${bobPid}/orders`), 403, 'forbidden');
    expectApiError(await app.inject({ method: 'DELETE', url: `/api/orders/${bobOrder.id}`, cookies: alice.cookies }), 403, 'forbidden');
    expect((await get(alice, `/api/participants/${alicePid}/portfolio`)).statusCode).toBe(200);

    const detail = (await get(alice, `/api/leagues/${league.id}`)).json<LeagueDetail>();
    const aiPid = detail.rankings.find((r) => r.kind === 'ai')!.participant_id;
    expect((await get(bob, `/api/participants/${aiPid}/portfolio`)).statusCode).toBe(200);
    expect((await get(bob, `/api/participants/${aiPid}/orders`)).statusCode).toBe(200);
    expectApiError(await order(bob, aiPid, { symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 1 }), 403, 'forbidden');
    expectApiError(await get(bob, '/api/participants/9999/portfolio'), 404, 'not_found');
  });

  it('accepts orders while SIM_ALWAYS_OPEN is on outside market hours', async () => {
    setClock(Date.UTC(2026, 9, 17, 12, 0)); // Saturday
    config.simAlwaysOpen = true;
    feedMarket('US');
    const league = await createLeague(alice, { market: 'US', agent_ids: [] });
    expect(league.status).toBe('active');
    const status = (await get(alice, '/api/market/US/status')).json<MarketStatus>();
    expect(status).toMatchObject({ market: 'US', open: true, next_open: null });
    expect(status.note).toContain('데모 모드');

    const placed = await order(alice, league.my_participant_id!, { symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 2 });
    expect(placed.statusCode, placed.body).toBe(200);
    setClock(clockNow() + MIN);
    expect(matchOrders(feedMarket('US')).map((o) => o.status)).toEqual(['filled']);
  });
});

describe('market and agents', () => {
  it('lists symbols with cached quotes and market status', async () => {
    const rows = (await get(alice, '/api/market/KR/symbols')).json<SymbolRow[]>();
    expect(rows).toHaveLength(symbolsFor('KR').length);
    expect(rows[0]).toEqual({
      symbol: '005930',
      name: '삼성전자',
      market: 'KR',
      exchange: 'KOSPI',
      kind: 'stock',
      leverage: 1,
      underlying: null,
      category: '반도체',
      price: 50_000,
      change_pct: 0,
      ts: KR_OPEN + HOUR,
      stale: false,
    });
    expect(rows.find((r) => r.symbol === '252670')).toMatchObject({
      name: 'KODEX 200선물인버스2X',
      kind: 'etf',
      leverage: -2,
      underlying: '069500',
      category: '인버스',
    });
    setClock(clockNow() + 10 * MIN);
    expect((await get(alice, '/api/market/kr/symbols')).json<SymbolRow[]>()[0]!.stale).toBe(true);

    const kr = (await get(alice, '/api/market/KR/status')).json<MarketStatus>();
    expect(kr).toMatchObject({ market: 'KR', open: true, next_open: null });
    const us = (await get(alice, '/api/market/US/status')).json<MarketStatus>();
    expect(us.open).toBe(false);
    expect(us.next_open).toBeGreaterThan(clockNow());
    expectApiError(await get(alice, '/api/market/JP/status'), 400, 'validation');
  });

  it('returns intraday points of the latest session', async () => {
    storeQuotes(feedMarket('KR', {}, KR_OPEN + 5 * MIN));
    storeQuotes(feedMarket('KR', { '005930': { price: 51_000 } }, KR_OPEN + 6 * MIN));
    storeQuotes(feedMarket('KR', {}, KR_OPEN - 24 * HOUR));

    const res = (await get(alice, '/api/market/quote/005930/intraday')).json<{ symbol: string; points: unknown[] }>();
    expect(res).toEqual({
      symbol: '005930',
      points: [
        { ts: KR_OPEN + 5 * MIN, price: 50_000 },
        { ts: KR_OPEN + 6 * MIN, price: 51_000 },
      ],
    });
    expect((await get(alice, '/api/market/quote/AAPL/intraday')).json()).toEqual({ symbol: 'AAPL', points: [] });
    expectApiError(await get(alice, '/api/market/quote/NOPE/intraday'), 404, 'not_found');
  });

  it('lists agents and shows agent detail', async () => {
    const list = (await get(bob, '/api/agents')).json<{ id: number; enabled: boolean }[]>();
    expect(list.map((a) => a.id)).toEqual([agents.baseline, agents.momentum, agents.claude]);
    expect(list.find((a) => a.id === agents.claude)!.enabled).toBe(false);

    const detail = await get(bob, `/api/agents/${agents.baseline}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ agent: { id: agents.baseline, model: 'baseline' }, recent_decisions: [] });
    expectApiError(await get(bob, '/api/agents/9999'), 404, 'not_found');
  });
});

describe('admin', () => {
  it('returns 403 for normal users', async () => {
    const league = await createLeague(alice);
    expectApiError(await app.inject({ method: 'POST', url: '/api/admin/collect', cookies: bob.cookies }), 403, 'forbidden');
    const run = await app.inject({
      method: 'POST',
      url: `/api/admin/agents/${agents.baseline}/run`,
      cookies: bob.cookies,
      payload: { league_id: league.id },
    });
    expectApiError(run, 403, 'forbidden');
    expect(collectorTicks).toBe(0);
  });

  it('forces a quote tick that also matches pending orders', async () => {
    const league = await createLeague(alice);
    const pid = league.my_participant_id!;
    await order(alice, pid, { symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 1 });
    setClock(clockNow() + MIN);

    const res = await app.inject({ method: 'POST', url: '/api/admin/collect', cookies: admin.cookies });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ count: symbolsFor('KR').length });
    expect(collectorTicks).toBe(1);
    expect((await get(alice, `/api/participants/${pid}/orders?status=filled`)).json<Order[]>()).toHaveLength(1);
  });

  it('refuses a forced run with 409 while that participant is already deciding', async () => {
    const league = await createLeague(alice);
    let release: () => void = () => {};
    let calls = 0;
    setProviderResolver(() => ({
      decide: async () => {
        calls++;
        await new Promise<void>((resolve) => (release = resolve));
        return { decision: { market_view: '', orders: [] }, raw: '{}' };
      },
    }));
    try {
      const run = () =>
        app.inject({
          method: 'POST',
          url: `/api/admin/agents/${agents.baseline}/run`,
          cookies: admin.cookies,
          payload: { league_id: league.id },
        });
      const first = run();
      await vi.waitFor(() => expect(calls).toBe(1));
      expectApiError(await run(), 409, 'agent_busy');
      release();
      expect((await first).json<DecisionLog>().status).toBe('hold');
    } finally {
      setProviderResolver(null);
    }
  });

  it('forces an agent decision in a league', async () => {
    const league = await createLeague(alice);
    const run = (agentId: number, leagueId: number) =>
      app.inject({
        method: 'POST',
        url: `/api/admin/agents/${agentId}/run`,
        cookies: admin.cookies,
        payload: { league_id: leagueId },
      });

    const res = await run(agents.baseline, league.id);
    expect(res.statusCode, res.body).toBe(200);
    const log = res.json<DecisionLog>();
    expect(log).toMatchObject({ agent_id: agents.baseline, league_id: league.id, status: 'ok' });
    expect(log.accepted_order_ids.length).toBeGreaterThan(0);

    expectApiError(await run(agents.claude, league.id), 400, 'agent_disabled');
    expectApiError(await run(agents.baseline, 9999), 404, 'not_found');
    expectApiError(await run(9999, league.id), 404, 'not_found');
    expectApiError(
      await app.inject({ method: 'POST', url: `/api/admin/agents/${agents.baseline}/run`, cookies: admin.cookies, payload: {} }),
      400,
      'validation',
    );
  });
});
