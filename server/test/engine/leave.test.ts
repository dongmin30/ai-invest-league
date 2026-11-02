import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Order, RankingRow } from '../../../shared/api-types';
import { db } from '../../src/db/db';
import {
  canViewLeague,
  countOpenOwnedLeagues,
  createLeague,
  getLeagueSummary,
  joinLeague,
  joinLeagueByCode,
  leaveLeague,
  listLeagues,
  myDashboard,
  updateLeagueStatuses,
} from '../../src/engine/leagues';
import { matchOrders } from '../../src/engine/matcher';
import { EngineError } from '../../src/engine/orders';
import { getPortfolio } from '../../src/engine/portfolio';
import { computeRankings, leagueAverages } from '../../src/engine/ranking';
import { getEquitySeries, takeSnapshots } from '../../src/engine/snapshots';
import { getLeagueRow, getOrderRow, getParticipantRow } from '../../src/engine/store';
import { bus } from '../../src/lib/bus';
import { storeQuotes } from '../../src/market/collector';
import {
  HOUR,
  KR_CLOSE,
  KR_OPEN,
  MIN,
  activeLeague,
  buy,
  clockNow,
  feed,
  makeAgent,
  makeUser,
  quote,
  resetEngineState,
  restoreEngineState,
  sell,
  setClock,
} from './helpers';

const SAMSUNG = '005930';
const HYNIX = '000660';
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

function agentParticipant(leagueId: number, agentId: number): number {
  return db.prepare('SELECT id FROM participants WHERE league_id = ? AND agent_id = ?').pluck().get(leagueId, agentId) as number;
}

/** Fills a market BUY for each participant at `price`. */
function fillBuys(price: number, ...orders: [participantId: number, symbol: string, qty: number][]): void {
  feed(...[...new Set(orders.map(([, s]) => s))].map((s) => quote(s, price)));
  for (const [pid, symbol, qty] of orders) buy(pid, symbol, qty);
  setClock(clockNow() + MIN);
  matchOrders(feed(...[...new Set(orders.map(([, s]) => s))].map((s) => quote(s, price))));
}

describe('leaveLeague while recruiting', () => {
  beforeEach(() => resetEngineState(SATURDAY));
  afterEach(() => restoreEngineState());

  it('removes the participant, so the user may join again', () => {
    const league = createLeague({
      name: '모집 리그',
      market: 'KR',
      type: 'custom',
      duration_days: 3,
      is_public: true,
      owner_id: makeUser(),
      start_at: KR_OPEN,
    });
    expect(league.status).toBe('recruiting');
    const userId = makeUser();
    const pid = joinLeague(league.id, { userId });
    expect(getLeagueSummary(league.id, userId)).toMatchObject({ joined: true, participant_count: 2 });

    const rankings: RankingRow[][] = [];
    const listener = (e: { league_id: number; rankings: RankingRow[] }) => rankings.push(e.rankings);
    bus.on('rankings', listener);
    try {
      expect(leaveLeague(league.id, userId)).toEqual({ forfeited: false });
    } finally {
      bus.off('rankings', listener);
    }
    expect(getParticipantRow(pid)).toBeUndefined();
    expect(getLeagueSummary(league.id, userId)).toMatchObject({
      joined: false,
      my_participant_id: null,
      left: false,
      participant_count: 1,
    });
    expect(myDashboard(userId)).toEqual([]);
    expect(rankings).toHaveLength(1);
    expectCode(() => leaveLeague(league.id, userId), 'not_joined');

    const again = joinLeague(league.id, { userId });
    expect(getLeagueSummary(league.id, userId)).toMatchObject({ joined: true, my_participant_id: again });
  });

  it('frees the owner slot of a custom league the owner left', () => {
    const ownerId = makeUser();
    const league = createLeague({
      name: '내 리그',
      market: 'KR',
      type: 'custom',
      duration_days: 3,
      is_public: true,
      owner_id: ownerId,
      start_at: KR_OPEN,
    });
    expect(countOpenOwnedLeagues(ownerId)).toBe(1);
    leaveLeague(league.id, ownerId);
    expect(countOpenOwnedLeagues(ownerId)).toBe(0);
    expect(getLeagueRow(league.id)!.owner_id).toBe(ownerId);
  });
});

describe('leaveLeague while active (forfeit)', () => {
  beforeEach(() => resetEngineState(KR_OPEN + HOUR));
  afterEach(() => restoreEngineState());

  it('cancels pending orders, keeps holdings and drops the user from standings for good', () => {
    const agentId = makeAgent('기준선 봇');
    const { leagueId, participantId: owner } = activeLeague('KR', { agent_ids: [agentId] });
    const ai = agentParticipant(leagueId, agentId);
    const userId = makeUser('떠날 사람');
    const me = joinLeague(leagueId, { userId });
    fillBuys(80_000, [me, SAMSUNG, 10], [owner, SAMSUNG, 5], [ai, SAMSUNG, 5]);
    const pendingBuy = buy(me, SAMSUNG, 1, 50_000);
    const pendingSell = sell(me, SAMSUNG, 2, 100_000);
    expect(computeRankings(leagueId)).toHaveLength(3);

    const orders: Order[] = [];
    const rankings: RankingRow[][] = [];
    const onOrder = (e: { order: Order }) => orders.push(e.order);
    const onRankings = (e: { rankings: RankingRow[] }) => rankings.push(e.rankings);
    bus.on('order', onOrder);
    bus.on('rankings', onRankings);
    try {
      expect(leaveLeague(leagueId, userId)).toEqual({ forfeited: true });
    } finally {
      bus.off('order', onOrder);
      bus.off('rankings', onRankings);
    }

    for (const id of [pendingBuy.id, pendingSell.id]) {
      expect(getOrderRow(id)).toMatchObject({ status: 'canceled', reject_reason: '리그에서 나가 취소되었습니다.' });
    }
    expect(orders.map((o) => [o.id, o.status])).toEqual([
      [pendingBuy.id, 'canceled'],
      [pendingSell.id, 'canceled'],
    ]);
    expect(rankings).toHaveLength(1);
    expect(rankings[0]!.map((r) => r.participant_id).sort()).toEqual([owner, ai].sort());

    expect(getParticipantRow(me)!.left_at).toBe(clockNow());
    expect(getPortfolio(me).holdings).toEqual([expect.objectContaining({ symbol: SAMSUNG, quantity: 10 })]);

    const standings = computeRankings(leagueId);
    expect(standings.map((r) => r.participant_id)).not.toContain(me);
    const ownerRow = standings.find((r) => r.participant_id === owner)!;
    expect(leagueAverages(leagueId, standings).human_avg_return).toBeCloseTo(ownerRow.return_rate, 12);
    expect(getLeagueSummary(leagueId, userId)).toMatchObject({
      joined: false,
      my_participant_id: null,
      left: true,
      participant_count: 2,
      ai_count: 1,
    });
    expect(myDashboard(userId)).toEqual([]);
    expect(getEquitySeries(leagueId, null).map((s) => s.participant_id)).not.toContain(me);
    expect(takeSnapshots(leagueId)).toBe(2);
    expect(db.prepare('SELECT COUNT(*) FROM snapshots WHERE participant_id = ?').pluck().get(me)).toBe(0);

    expectCode(() => buy(me, SAMSUNG, 1), 'participant_left');
    expectCode(() => joinLeague(leagueId, { userId }), 'left_league');
    expectCode(() => leaveLeague(leagueId, userId), 'not_joined');
    // AI participants are untouched.
    expect(buy(ai, SAMSUNG, 1).status).toBe('pending');
  });

  it('hides a private league from a member who left, but not from its owner', () => {
    const { leagueId, ownerId } = activeLeague('KR', { is_public: false });
    const code = getLeagueRow(leagueId)!.invite_code!;
    const member = makeUser();
    joinLeague(leagueId, { userId: member }, code);
    expect(canViewLeague(getLeagueRow(leagueId)!, member)).toBe(true);

    leaveLeague(leagueId, member);
    expect(canViewLeague(getLeagueRow(leagueId)!, member)).toBe(false);
    expect(listLeagues(member).map((l) => l.id)).not.toContain(leagueId);
    expectCode(() => joinLeagueByCode(member, code), 'left_league');

    expect(countOpenOwnedLeagues(ownerId)).toBe(1);
    leaveLeague(leagueId, ownerId);
    expect(canViewLeague(getLeagueRow(leagueId)!, ownerId)).toBe(true);
    expect(countOpenOwnedLeagues(ownerId)).toBe(0);
    expect(getLeagueSummary(leagueId, ownerId)).toMatchObject({ joined: false, left: true, participant_count: 0 });
  });

  it('does not wait for closing prints of holdings of users who left, and gives them no final rank', () => {
    const { leagueId, participantId: owner } = activeLeague('KR', { duration_days: 1 });
    const userId = makeUser();
    const me = joinLeague(leagueId, { userId });
    fillBuys(80_000, [owner, SAMSUNG, 5], [me, HYNIX, 5]);
    leaveLeague(leagueId, userId);

    setClock(KR_CLOSE);
    storeQuotes(feed(quote(SAMSUNG, 81_000, KR_CLOSE)));
    expect(updateLeagueStatuses().finished).toEqual([leagueId]);
    expect(getParticipantRow(owner)).toMatchObject({ final_rank: 1 });
    expect(getParticipantRow(me)).toMatchObject({ final_rank: null, final_return: null });
  });

  it('refuses finished leagues, leagues past end_at, unknown leagues and non-members', () => {
    const { leagueId, ownerId } = activeLeague('KR', { duration_days: 1 });
    expectCode(() => leaveLeague(leagueId, makeUser()), 'not_joined');
    expectCode(() => leaveLeague(9999, ownerId), 'not_found');

    setClock(KR_CLOSE);
    expectCode(() => leaveLeague(leagueId, ownerId), 'league_finished');
    storeQuotes(feed(quote(SAMSUNG, 80_000, KR_CLOSE)));
    expect(updateLeagueStatuses().finished).toEqual([leagueId]);
    expectCode(() => leaveLeague(leagueId, ownerId), 'league_finished');
    expect(getLeagueSummary(leagueId, ownerId)).toMatchObject({ joined: true, left: false });
  });
});
