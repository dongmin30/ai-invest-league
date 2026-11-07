import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeagueSummary, RankingRow } from '../../../shared/api-types';
import { config } from '../../src/config';
import { db } from '../../src/db/db';
import {
  canViewLeague,
  createLeague,
  ensureOfficialLeagues,
  getLeagueSummary,
  joinLeague,
  joinLeagueByCode,
  listLeagues,
  listOfficialSeries,
  myDashboard,
  nextScheduledStart,
  setOfficialSeriesEnabled,
  updateLeagueStatuses,
} from '../../src/engine/leagues';
import { matchOrders } from '../../src/engine/matcher';
import { EngineError } from '../../src/engine/orders';
import { getPortfolio } from '../../src/engine/portfolio';
import { computeRankings } from '../../src/engine/ranking';
import { getEquitySeries } from '../../src/engine/snapshots';
import { getLeagueRow, getOrderRow, getParticipantRow } from '../../src/engine/store';
import { bus } from '../../src/lib/bus';
import { POST_CLOSE_FETCH_MS, storeQuotes } from '../../src/market/collector';
import {
  HOUR,
  KR_CLOSE,
  KR_OPEN,
  MIN,
  US_OPEN,
  activeLeague,
  buy,
  clockNow,
  feed,
  makeAgent,
  makeUser,
  quote,
  resetEngineState,
  restoreEngineState,
  setClock,
} from './helpers';

const SAMSUNG = '005930';
const DAY = 24 * HOUR;
/** Saturday 2026-10-17 12:00 KST. */
const SATURDAY = Date.UTC(2026, 9, 17, 3, 0);

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected EngineError '${code}'`);
}

function custom(overrides: Partial<Parameters<typeof createLeague>[0]> = {}): LeagueSummary {
  return createLeague({
    name: '커스텀',
    market: 'KR',
    type: 'custom',
    duration_days: 3,
    is_public: true,
    owner_id: makeUser(),
    ...overrides,
  });
}

describe('createLeague', () => {
  beforeEach(() => resetEngineState(SATURDAY));
  afterEach(() => restoreEngineState());

  it('defaults to the next open and ends at the close of the N-th trading day', () => {
    const kr3d = createLeague({ name: 'KR 3일', market: 'KR', type: '3d', is_public: true, owner_id: null });
    expect(kr3d).toMatchObject({
      status: 'recruiting',
      currency: 'KRW',
      start_cash: 10_000_000,
      decision_interval_min: 30,
      max_orders_per_day: 20,
      start_at: KR_OPEN,
      end_at: KR_CLOSE + 2 * DAY,
      participant_count: 0,
      joined: false,
      my_participant_id: null,
    });
    const kr1w = createLeague({ name: 'KR 1주', market: 'KR', type: '1w', is_public: true, owner_id: null });
    expect(kr1w.end_at).toBe(KR_CLOSE + 4 * DAY);
    const kr1m = createLeague({ name: 'KR 1개월', market: 'KR', type: '1m', is_public: true, owner_id: null });
    expect(kr1m.end_at).toBe(Date.UTC(2026, 10, 13, 6, 30));
    expect(kr1m).toMatchObject({ decision_interval_min: 180, max_orders_per_day: 5 });

    // US 1m crosses the end of daylight saving time (Nov 1): the close moves to 21:00 UTC.
    const us1m = createLeague({ name: 'US 1개월', market: 'US', type: '1m', is_public: true, owner_id: null });
    expect(us1m).toMatchObject({ currency: 'USD', start_cash: 10_000, start_at: US_OPEN });
    expect(us1m.end_at).toBe(Date.UTC(2026, 10, 13, 21, 0));
    const row = getLeagueRow(us1m.id)!;
    expect(row).toMatchObject({ fee_rate: 0.001, tax_rate: 0, max_position_pct: 0.4, invite_code: null });
  });

  it('custom leagues use duration_days with the custom interval and limit', () => {
    const league = custom({ duration_days: 7, start_cash: 5_000_000 });
    expect(league).toMatchObject({
      type: 'custom',
      start_at: KR_OPEN,
      end_at: KR_CLOSE + 8 * DAY, // Mon..Fri, Mon, Tue
      decision_interval_min: 60,
      max_orders_per_day: 10,
      start_cash: 5_000_000,
    });
    expectCode(() => custom({ duration_days: undefined }), 'bad_duration');
    expectCode(() => custom({ duration_days: 0 }), 'bad_duration');
    expectCode(() => custom({ duration_days: 21 }), 'bad_duration');
    expectCode(() => custom({ duration_days: 2.5 }), 'bad_duration');
    expectCode(() => custom({ name: '   ' }), 'bad_name');
    expectCode(() => custom({ start_cash: -1 }), 'bad_start_cash');
    expectCode(() => custom({ agent_ids: [999] }), 'bad_agent');
  });

  it('start_now while the market is open counts today as day 1', () => {
    setClock(KR_OPEN + HOUR);
    const league = custom({ duration_days: 1, start_at: clockNow() });
    expect(league).toMatchObject({ status: 'active', start_at: KR_OPEN + HOUR, end_at: KR_CLOSE });
  });

  it('start_now after the close counts from the next open', () => {
    setClock(KR_CLOSE + HOUR);
    const league = custom({ duration_days: 1, start_at: clockNow() });
    expect(league).toMatchObject({ status: 'active', start_at: KR_CLOSE + HOUR, end_at: KR_CLOSE + DAY });
  });

  it('joins the owner and the given agents, and gives private leagues an invite code', () => {
    const ownerId = makeUser('방장');
    const a1 = makeAgent('봇1');
    const a2 = makeAgent('봇2');
    const league = custom({ owner_id: ownerId, agent_ids: [a1, a2, a1], is_public: false });
    expect(league).toMatchObject({ participant_count: 3, ai_count: 2, joined: true, is_public: false });
    expect(getParticipantRow(league.my_participant_id!)).toMatchObject({ user_id: ownerId, cash: 10_000_000 });
    expect(getLeagueRow(league.id)!.invite_code).toMatch(/^[A-Z2-9]{6}$/);
  });
});

describe('joinLeague', () => {
  beforeEach(() => resetEngineState(SATURDAY));
  afterEach(() => restoreEngineState());

  it('allows joining recruiting leagues once', () => {
    const official = createLeague({ name: 'KR 1주', market: 'KR', type: '1w', is_public: true, owner_id: null });
    const userId = makeUser();
    const pid = joinLeague(official.id, { userId });
    expect(getParticipantRow(pid)).toMatchObject({ league_id: official.id, user_id: userId, agent_id: null, cash: 10_000_000 });
    expectCode(() => joinLeague(official.id, { userId }), 'already_joined');
    expect(getLeagueSummary(official.id, userId)).toMatchObject({ joined: true, my_participant_id: pid });
  });

  it('keeps official leagues open for 24 hours after start and custom leagues until finished', () => {
    const official = createLeague({ name: 'KR 3일', market: 'KR', type: '3d', is_public: true, owner_id: null });
    const customLeague = custom();
    setClock(KR_OPEN + MIN);
    updateLeagueStatuses();
    expect(getLeagueRow(official.id)!.status).toBe('active');
    expect(joinLeague(official.id, { userId: makeUser() })).toBeGreaterThan(0);
    expect(joinLeague(customLeague.id, { userId: makeUser() })).toBeGreaterThan(0);

    setClock(KR_OPEN + DAY - MIN);
    expect(joinLeague(official.id, { userId: makeUser() })).toBeGreaterThan(0);
    setClock(KR_OPEN + DAY);
    expectCode(() => joinLeague(official.id, { userId: makeUser() }), 'league_closed');
    expect(joinLeague(customLeague.id, { userId: makeUser() })).toBeGreaterThan(0);

    setClock(KR_CLOSE + 3 * DAY);
    updateLeagueStatuses();
    expect(getLeagueRow(customLeague.id)!.status).toBe('finished');
    expectCode(() => joinLeague(customLeague.id, { userId: makeUser() }), 'league_closed');
  });

  it('requires the invite code for private leagues', () => {
    const league = custom({ is_public: false });
    const code = getLeagueRow(league.id)!.invite_code!;
    expectCode(() => joinLeague(league.id, { userId: makeUser() }), 'bad_invite');
    expectCode(() => joinLeague(league.id, { userId: makeUser() }, 'WRONG1'), 'bad_invite');
    expect(joinLeague(league.id, { userId: makeUser() }, code.toLowerCase())).toBeGreaterThan(0);
    expect(joinLeague(league.id, { agentId: makeAgent('봇') })).toBeGreaterThan(0);
  });

  it('joins a private league from its invite code alone', () => {
    const league = custom({ is_public: false });
    const code = getLeagueRow(league.id)!.invite_code!;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    const userId = makeUser();
    const joined = joinLeagueByCode(userId, ` ${code.toLowerCase()} `);
    expect(joined).toEqual({ league_id: league.id, participant_id: expect.any(Number) });
    expect(getLeagueSummary(league.id, userId)).toMatchObject({ joined: true, my_participant_id: joined.participant_id });
    expectCode(() => joinLeagueByCode(userId, code), 'already_joined');
    expectCode(() => joinLeagueByCode(makeUser(), 'ZZZZZZ'), 'bad_invite');
    expectCode(() => joinLeagueByCode(makeUser(), ''), 'bad_invite');
    expect(getLeagueRow(custom().id)!.invite_code).toBeNull();
  });

  it('gives unfinished private leagues distinct invite codes', () => {
    const codes = Array.from({ length: 30 }, () => getLeagueRow(custom({ is_public: false }).id)!.invite_code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('validates the joiner', () => {
    const league = custom();
    expectCode(() => joinLeague(league.id, {}), 'bad_participant');
    expectCode(() => joinLeague(league.id, { userId: makeUser(), agentId: makeAgent('x') }), 'bad_participant');
    expectCode(() => joinLeague(league.id, { agentId: 999 }), 'bad_agent');
    expectCode(() => joinLeague(424242, { userId: makeUser() }), 'not_found');
    expect(getLeagueSummary(424242, null)).toBeNull();
  });
});

describe('canViewLeague', () => {
  beforeEach(() => resetEngineState(SATURDAY));
  afterEach(() => restoreEngineState());

  it('shows public leagues to everyone and private ones only to the owner and participants', () => {
    const ownerId = makeUser();
    const pub = getLeagueRow(custom({ owner_id: ownerId }).id)!;
    const priv = getLeagueRow(custom({ owner_id: ownerId, is_public: false }).id)!;
    const member = makeUser();
    joinLeague(priv.id, { userId: member }, priv.invite_code!);
    const outsider = makeUser();

    expect(canViewLeague(pub, outsider)).toBe(true);
    expect(canViewLeague(priv, outsider)).toBe(false);
    expect(canViewLeague(priv, ownerId)).toBe(true);
    expect(canViewLeague(priv, member)).toBe(true);
  });
});

describe('listLeagues', () => {
  beforeEach(() => resetEngineState(SATURDAY));
  afterEach(() => restoreEngineState());

  it('shows public leagues plus private leagues the viewer joined, with filters', () => {
    const memberId = makeUser();
    const outsiderId = makeUser();
    const pub = custom({ market: 'US' });
    const priv = custom({ owner_id: memberId, is_public: false });
    setClock(KR_OPEN + MIN);
    const running = custom({ start_at: KR_OPEN });

    expect(listLeagues(outsiderId).map((l) => l.id)).toEqual([running.id, pub.id]);
    expect(listLeagues(null).map((l) => l.id)).toEqual([running.id, pub.id]);
    expect(listLeagues(memberId).map((l) => l.id)).toEqual([running.id, priv.id, pub.id]);
    expect(listLeagues(memberId, { status: 'recruiting', market: 'KR' }).map((l) => l.id)).toEqual([priv.id]);
    expect(listLeagues(memberId, { market: 'US' }).map((l) => l.id)).toEqual([pub.id]);
    expect(listLeagues(memberId).find((l) => l.id === priv.id)).toMatchObject({ joined: true, is_public: false });
  });
});

/** Switches every official series on without running ensureOfficialLeagues(). */
function enableAllSeries(): void {
  const insert = db.prepare('INSERT INTO official_series (market, type, enabled) VALUES (?, ?, 1)');
  for (const market of ['KR', 'US', 'ALL']) for (const type of ['3d', '1w', '1m']) insert.run(market, type);
}

describe('official series switches', () => {
  beforeEach(() => resetEngineState(SATURDAY));
  afterEach(() => restoreEngineState());

  const official = (market: string, type: string) =>
    db
      .prepare('SELECT id, name, status, end_at FROM leagues WHERE owner_id IS NULL AND market = ? AND type = ? ORDER BY id')
      .all(market, type) as { id: number; name: string; status: string; end_at: number }[];

  it('runs no official league until an admin switches its series on', () => {
    makeAgent('기준선 봇', { provider: 'rule', model: 'baseline' });
    expect(ensureOfficialLeagues()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM leagues').pluck().get()).toBe(0);
    const series = listOfficialSeries();
    expect(series).toHaveLength(9);
    expect(series.every((s) => !s.enabled && s.active_count === 0 && s.recruiting_count === 0)).toBe(true);

    const after = setOfficialSeriesEnabled('KR', '1w', true);
    expect(after.find((s) => s.market === 'KR' && s.type === '1w')).toEqual({
      market: 'KR',
      type: '1w',
      enabled: true,
      active_count: 0,
      recruiting_count: 1,
    });
    expect(after.filter((s) => s.enabled)).toHaveLength(1);
    expect(official('KR', '1w').map((l) => [l.name, l.status])).toEqual([['KR 1주 리그 #1', 'recruiting']]);
    expect(db.prepare('SELECT COUNT(*) FROM leagues').pluck().get()).toBe(1);
  });

  it('switching off deletes the recruiting league and ends the active one now, leaving custom leagues alone', () => {
    const user = makeUser();
    makeAgent('기준선 봇', { provider: 'rule', model: 'baseline' });
    setOfficialSeriesEnabled('KR', '3d', true);
    const customLeague = custom({ owner_id: user });
    setClock(KR_OPEN + HOUR);
    updateLeagueStatuses();
    ensureOfficialLeagues(); // schedules #2 while #1 is active
    const [first, second] = official('KR', '3d');
    expect([first!.status, second!.status]).toEqual(['active', 'recruiting']);
    const trader = joinLeague(first!.id, { userId: user });
    joinLeague(second!.id, { userId: user });
    feed(quote(SAMSUNG, 80_000));
    const pending = buy(trader, SAMSUNG, 1, 50_000);
    const finishedAt = clockNow();

    const after = setOfficialSeriesEnabled('KR', '3d', false);
    expect(after.find((s) => s.market === 'KR' && s.type === '3d')).toMatchObject({ enabled: false, active_count: 0, recruiting_count: 0 });
    expect(official('KR', '3d')).toEqual([{ id: first!.id, name: 'KR 3일 리그 #1', status: 'finished', end_at: finishedAt }]);
    expect(getOrderRow(pending.id)).toMatchObject({ status: 'canceled', reject_reason: '리그 종료로 취소되었습니다.' });
    // Standings are frozen (a participant who never traded keeps no rank, as at a normal finish).
    expect(getParticipantRow(trader)).toMatchObject({ final_rank: null, final_return: 0 });
    expect(db.prepare('SELECT COUNT(*) FROM leagues WHERE id = ?').pluck().get(second!.id)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM participants WHERE league_id = ?').pluck().get(second!.id)).toBe(0);
    expect(getLeagueRow(customLeague.id)!.status).toBe('active');

    // Stays off on later runs; switching back on starts a fresh league.
    expect(ensureOfficialLeagues()).toEqual([]);
    setOfficialSeriesEnabled('KR', '3d', true);
    expect(official('KR', '3d').map((l) => [l.name, l.status])).toEqual([
      ['KR 3일 리그 #1', 'finished'],
      ['KR 3일 리그 #2', 'recruiting'], // from the next open; the deleted #2 never ran, so its number is reused
    ]);
  });
});

describe('official series switched off on an upgraded database', () => {
  afterEach(() => restoreEngineState());

  // Leagues created while every series was implicitly on; official_series is still empty.
  function seedOldOfficialLeagues(): void {
    enableAllSeries();
    ensureOfficialLeagues();
    db.prepare('DELETE FROM official_series').run();
  }

  it('ends started leagues (also one not yet marked active), deletes future ones, and waits for closing prints', () => {
    resetEngineState(SATURDAY);
    seedOldOfficialLeagues();
    const kr3d = db.prepare("SELECT id FROM leagues WHERE market = 'KR' AND type = '3d'").pluck().get() as number;
    const all1w = db.prepare("SELECT id FROM leagues WHERE market = 'ALL' AND type = '1w'").pluck().get() as number;
    const us1m = db.prepare("SELECT id FROM leagues WHERE market = 'US' AND type = '1m'").pluck().get() as number;
    // US 1m ran its last day and is waiting for the closing print; ALL 1w has a user decision log.
    db.prepare("UPDATE leagues SET status = 'active', start_at = ?, end_at = ? WHERE id = ?").run(KR_OPEN - DAY, KR_OPEN + HOUR / 2, us1m);
    const agent = makeAgent('기준선 봇', { provider: 'rule', model: 'baseline' });
    const pid = joinLeague(all1w, { agentId: agent });
    db.prepare(
      "INSERT INTO decision_logs (agent_id, participant_id, league_id, ts, status, latency_ms) VALUES (?, ?, ?, ?, 'hold', 1)",
    ).run(agent, pid, all1w, SATURDAY);

    setClock(KR_OPEN + HOUR); // KR and 통합 leagues have started, but no status update has run yet
    ensureOfficialLeagues();

    expect(getLeagueRow(kr3d)).toMatchObject({ status: 'finished', end_at: KR_OPEN + HOUR });
    expect(getLeagueRow(all1w)).toMatchObject({ status: 'finished' });
    expect(getLeagueRow(us1m)).toMatchObject({ status: 'active' }); // left to updateLeagueStatuses()
    expect(db.prepare("SELECT COUNT(*) FROM leagues WHERE market = 'US' AND status = 'recruiting'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM leagues WHERE status <> 'finished'").pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM decision_logs WHERE league_id = ?').pluck().get(all1w)).toBe(1);

    setClock(KR_OPEN + HOUR / 2 + POST_CLOSE_FETCH_MS + MIN);
    updateLeagueStatuses();
    expect(getLeagueRow(us1m)!.status).toBe('finished');
  });

  it('deletes a recruiting league together with its decision logs', () => {
    resetEngineState(SATURDAY);
    seedOldOfficialLeagues();
    const league = db.prepare("SELECT id FROM leagues WHERE market = 'KR' AND type = '1w'").pluck().get() as number;
    const agent = makeAgent('기준선 봇', { provider: 'rule', model: 'baseline' });
    const pid = joinLeague(league, { agentId: agent });
    db.prepare(
      "INSERT INTO decision_logs (agent_id, participant_id, league_id, ts, status, latency_ms) VALUES (?, ?, ?, ?, 'hold', 1)",
    ).run(agent, pid, league, SATURDAY);

    ensureOfficialLeagues();
    expect(getLeagueRow(league)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) FROM decision_logs').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM leagues').pluck().get()).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('ensureOfficialLeagues', () => {
  beforeEach(() => {
    resetEngineState(SATURDAY);
    enableAllSeries();
  });
  afterEach(() => restoreEngineState());

  it('creates one league per market and type starting at the next open, joining enabled agents', () => {
    const claude = makeAgent('Claude 트레이더', { provider: 'claude', model: 'claude-opus-5-5' });
    makeAgent('로컬 LLM 트레이더', { provider: 'ollama', model: 'qwen3:8b', enabled: false });
    const krOnly = makeAgent('모멘텀 봇', { provider: 'rule', model: 'momentum', markets: 'KR' });

    const created = ensureOfficialLeagues();
    expect(created.map((l) => [l.name, l.status, l.start_at])).toEqual([
      ['KR 3일 리그 #1', 'recruiting', KR_OPEN],
      ['KR 1주 리그 #1', 'recruiting', KR_OPEN],
      ['KR 1개월 리그 #1', 'recruiting', KR_OPEN],
      ['US 3일 리그 #1', 'recruiting', US_OPEN],
      ['US 1주 리그 #1', 'recruiting', US_OPEN],
      ['US 1개월 리그 #1', 'recruiting', US_OPEN],
      // 통합 leagues open at the earlier of the KR and US opens and need agents trading both markets.
      ['통합 3일 리그 #1', 'recruiting', KR_OPEN],
      ['통합 1주 리그 #1', 'recruiting', KR_OPEN],
      ['통합 1개월 리그 #1', 'recruiting', KR_OPEN],
    ]);
    const agentsIn = (leagueId: number) =>
      db.prepare('SELECT agent_id FROM participants WHERE league_id = ? AND agent_id IS NOT NULL ORDER BY agent_id').pluck().all(leagueId);
    expect(agentsIn(created[0]!.id)).toEqual([claude, krOnly]);
    expect(agentsIn(created[3]!.id)).toEqual([claude]);
    expect(agentsIn(created[6]!.id)).toEqual([claude]);
    expect(created[6]).toMatchObject({ market: 'ALL', currency: 'KRW', fx_spread: 0.001, decision_interval_min: 60, max_orders_per_day: 30 });
    expect(created[0]).toMatchObject({ participant_count: 2, ai_count: 2, is_public: true });

    expect(ensureOfficialLeagues()).toEqual([]);

    db.prepare("UPDATE agents SET enabled = 1 WHERE provider = 'ollama'").run();
    ensureOfficialLeagues();
    expect(agentsIn(created[0]!.id)).toHaveLength(3);
  });

  it('schedules the next league per type once the current one is active', () => {
    ensureOfficialLeagues();
    setClock(KR_OPEN + MIN);
    expect(updateLeagueStatuses().activated).toHaveLength(6); // KR + 통합

    const created = ensureOfficialLeagues();
    expect(created.map((l) => [l.name, l.status, l.start_at])).toEqual([
      ['KR 3일 리그 #2', 'recruiting', KR_OPEN + 3 * DAY], // Thursday
      ['KR 1주 리그 #2', 'recruiting', KR_OPEN + 7 * DAY], // next Monday
      ['KR 1개월 리그 #2', 'recruiting', Date.UTC(2026, 10, 2, 0, 0)], // first trading day of November
      ['통합 3일 리그 #2', 'recruiting', KR_OPEN + 3 * DAY],
      ['통합 1주 리그 #2', 'recruiting', KR_OPEN + 7 * DAY],
      ['통합 1개월 리그 #2', 'recruiting', Date.UTC(2026, 10, 2, 0, 0)],
    ]);

    setClock(US_OPEN + MIN);
    updateLeagueStatuses();
    const us = ensureOfficialLeagues();
    expect(us.map((l) => l.start_at)).toEqual([
      US_OPEN + 3 * DAY,
      US_OPEN + 7 * DAY,
      Date.UTC(2026, 10, 2, 14, 30), // 09:30 EST after the DST change
    ]);
  });

  it('starts the first leagues immediately in SIM_ALWAYS_OPEN mode and still recruits the next ones', () => {
    config.simAlwaysOpen = true;
    const created = ensureOfficialLeagues();
    expect(created).toHaveLength(18);
    for (const market of ['KR', 'US', 'ALL'] as const) {
      for (const type of ['3d', '1w', '1m'] as const) {
        const statuses = created.filter((l) => l.market === market && l.type === type).map((l) => l.status);
        expect(statuses).toEqual(['active', 'recruiting']);
      }
    }
    expect(created[0]!.start_at).toBe(SATURDAY);
  });

  it('moves a scheduled start past holidays', () => {
    // Friday 2026-10-02 KST: the next Monday (10-05, 개천절 대체공휴일) is closed, so the 1w league starts Tuesday.
    const friday = Date.UTC(2026, 9, 2, 3, 0);
    expect(nextScheduledStart('KR', '1w', friday)).toBe(Date.UTC(2026, 9, 6, 0, 0));
    // From a Monday 10:00 KST the next 3d slot is Thursday.
    expect(nextScheduledStart('KR', '3d', KR_OPEN + HOUR)).toBe(KR_OPEN + 3 * DAY);
    // From a Thursday 10:00 KST the next 3d slot is the following Monday.
    expect(nextScheduledStart('KR', '3d', KR_OPEN + 3 * DAY + HOUR)).toBe(KR_OPEN + 7 * DAY);
    // December rolls over to January (2027-01-01 is closed).
    expect(nextScheduledStart('KR', '1m', Date.UTC(2026, 11, 10, 3, 0))).toBe(Date.UTC(2027, 0, 4, 0, 0));
  });
});

describe('updateLeagueStatuses', () => {
  beforeEach(() => resetEngineState(SATURDAY));
  afterEach(() => restoreEngineState());

  it('activates at start_at', () => {
    const league = custom();
    expect(updateLeagueStatuses()).toEqual({ activated: [], finished: [] });
    setClock(KR_OPEN);
    expect(updateLeagueStatuses()).toEqual({ activated: [league.id], finished: [] });
    expect(getLeagueRow(league.id)!.status).toBe('active');
  });

  it('finishes at end_at: cancels pending orders, takes a final snapshot and freezes the standings', () => {
    setClock(KR_OPEN + HOUR);
    const { leagueId, participantId: trader } = activeLeague('KR', { duration_days: 1 });
    const idle = joinLeague(leagueId, { userId: makeUser() });
    feed(quote(SAMSUNG, 80_000));
    buy(trader, SAMSUNG, 10);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(SAMSUNG, 80_000)));
    setClock(clockNow() + MIN);
    feed(quote(SAMSUNG, 88_000));
    const pending = buy(trader, SAMSUNG, 5, 50_000);

    const emitted: RankingRow[][] = [];
    const listener = (e: { rankings: RankingRow[] }) => emitted.push(e.rankings);
    bus.on('rankings', listener);
    setClock(KR_CLOSE);
    try {
      // The last quote predates the close: wait for the closing print instead of freezing on it.
      expect(updateLeagueStatuses()).toEqual({ activated: [], finished: [] });
      expect(getLeagueRow(leagueId)!.status).toBe('active');
      const closing = feed(quote(SAMSUNG, 88_000, KR_CLOSE));
      storeQuotes(closing);
      expect(updateLeagueStatuses()).toEqual({ activated: [], finished: [leagueId] });
    } finally {
      bus.off('rankings', listener);
    }

    expect(getLeagueRow(leagueId)!.status).toBe('finished');
    expect(getOrderRow(pending.id)).toMatchObject({ status: 'canceled', reject_reason: '리그 종료로 취소되었습니다.' });
    const finalEquity = 10_000_000 - 800_120 + 880_000;
    expect(db.prepare('SELECT ts, equity FROM snapshots WHERE participant_id = ?').get(trader)).toEqual({
      ts: KR_CLOSE,
      equity: finalEquity,
    });
    expect(getParticipantRow(trader)).toMatchObject({ final_rank: 1 });
    expect(getParticipantRow(trader)!.final_return).toBeCloseTo(finalEquity / 10_000_000 - 1, 12);
    expect(getParticipantRow(idle)).toMatchObject({ final_rank: null, final_return: 0 });
    expect(emitted).toHaveLength(1);

    // Later prices do not move a finished league, and orders are refused.
    feed(quote(SAMSUNG, 10_000, KR_CLOSE + DAY));
    setClock(KR_OPEN + DAY + HOUR);
    expect(computeRankings(leagueId)[0]).toMatchObject({ participant_id: trader, rank: 1, equity: finalEquity });
    // The portfolio shows the same frozen result, holdings priced at the close.
    const portfolio = getPortfolio(trader);
    expect(portfolio).toMatchObject({ equity: finalEquity, return_rate: getParticipantRow(trader)!.final_return });
    expect(portfolio.holdings).toEqual([expect.objectContaining({ symbol: SAMSUNG, quantity: 10, price: 88_000, value: 880_000 })]);
    expect(() => buy(trader, SAMSUNG, 1)).toThrow(EngineError);
    const series = getEquitySeries(leagueId, trader).find((s) => s.participant_id === trader)!;
    expect(series.points.at(-1)!.ts).toBe(KR_CLOSE);
    expect(updateLeagueStatuses()).toEqual({ activated: [], finished: [] });
  });

  it('finishes without a closing print once the post-close fetch window has passed', () => {
    setClock(KR_OPEN + HOUR);
    const { leagueId, participantId } = activeLeague('KR', { duration_days: 1 });
    feed(quote(SAMSUNG, 80_000));
    buy(participantId, SAMSUNG, 10);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(SAMSUNG, 80_000)));

    setClock(KR_CLOSE + POST_CLOSE_FETCH_MS - 1);
    expect(updateLeagueStatuses().finished).toEqual([]);
    setClock(KR_CLOSE + POST_CLOSE_FETCH_MS);
    expect(updateLeagueStatuses().finished).toEqual([leagueId]);
    expect(getParticipantRow(participantId)!.final_return).toBeCloseTo(-120 / 10_000_000, 12);
  });

  it('waits for the closing print of pending-order symbols, so a closing-auction order fills before the league finishes', () => {
    const HYNIX = '000660';
    setClock(KR_OPEN + HOUR);
    const { leagueId, participantId } = activeLeague('KR', { duration_days: 1 });
    feed(quote(SAMSUNG, 80_000), quote(HYNIX, 200_000));
    buy(participantId, SAMSUNG, 10);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(SAMSUNG, 80_000)));

    setClock(KR_CLOSE - 5 * MIN); // closing call auction
    const auction = buy(participantId, HYNIX, 1); // not held yet
    setClock(KR_CLOSE + 30_000);
    // The held symbol's closing print is in, the pending order's symbol's is not.
    matchOrders(feed(quote(SAMSUNG, 81_000, KR_CLOSE + 5_000)));
    expect(updateLeagueStatuses().finished).toEqual([]);

    // Scheduler order: collect → match, then the status update.
    matchOrders(feed(quote(HYNIX, 201_000, KR_CLOSE + 5_000)));
    expect(getOrderRow(auction.id)).toMatchObject({ status: 'filled', fill_price: 201_000 });
    expect(updateLeagueStatuses().finished).toEqual([leagueId]);
    expect(getOrderRow(auction.id)!.status).toBe('filled');
  });

  it('activates and finishes a league whose whole window has passed', () => {
    const league = custom({ duration_days: 1 });
    setClock(KR_CLOSE + MIN);
    expect(updateLeagueStatuses()).toEqual({ activated: [league.id], finished: [league.id] });
  });
});

describe('myDashboard', () => {
  beforeEach(() => resetEngineState(SATURDAY));
  afterEach(() => restoreEngineState());

  it('summarizes every joined league for the user', () => {
    const userId = makeUser('나');
    const claude = makeAgent('Claude 트레이더', { provider: 'claude', model: 'claude-opus-5-5' });
    const official = createLeague({ name: 'KR 1주', market: 'KR', type: '1w', is_public: true, owner_id: null, agent_ids: [claude] });
    joinLeague(official.id, { userId });
    setClock(KR_OPEN + HOUR);
    updateLeagueStatuses();
    const upcoming = custom({ owner_id: userId, start_at: KR_OPEN + DAY });
    custom(); // not joined

    const me = getLeagueSummary(official.id, userId)!.my_participant_id!;
    const ai = db.prepare('SELECT id FROM participants WHERE league_id = ? AND agent_id = ?').pluck().get(official.id, claude) as number;
    feed(quote(SAMSUNG, 80_000));
    buy(me, SAMSUNG, 10);
    buy(ai, SAMSUNG, 20);
    setClock(clockNow() + MIN);
    matchOrders(feed(quote(SAMSUNG, 80_000)));
    setClock(clockNow() + MIN);
    feed(quote(SAMSUNG, 84_000));

    const cards = myDashboard(userId);
    expect(cards.map((c) => [c.league.id, c.league.status])).toEqual([
      [official.id, 'active'],
      [upcoming.id, 'recruiting'],
    ]);
    const [active, recruiting] = cards;
    expect(active).toMatchObject({
      my_rank: 2,
      participant_count: 2,
      remaining_ms: official.end_at - clockNow(),
      best_ai_name: 'Claude 트레이더',
    });
    expect(active!.my_return_rate).toBeCloseTo(39_880 / 10_000_000, 12);
    expect(active!.best_ai_return).toBeCloseTo(79_760 / 10_000_000, 12);
    expect(active!.human_avg_return).toBeCloseTo(active!.my_return_rate, 12);
    expect(active!.ai_avg_return).toBeCloseTo(active!.best_ai_return!, 12);
    expect(recruiting).toMatchObject({
      my_rank: null,
      my_return_rate: 0,
      remaining_ms: KR_OPEN + DAY - clockNow(),
      best_ai_name: null,
      best_ai_return: null,
      ai_avg_return: null,
    });

    setClock(official.end_at);
    updateLeagueStatuses();
    const finished = myDashboard(userId).find((c) => c.league.id === official.id)!;
    expect(finished).toMatchObject({ remaining_ms: 0, my_rank: 2 });
  });
});
