import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_PAGE_MAX, listDecisions, runDecision, setProviderResolver } from '../../src/agents/runner';
import type { LLMProvider } from '../../src/agents/types';
import { db } from '../../src/db/db';
import { createLeague } from '../../src/engine/leagues';
import { matchOrders } from '../../src/engine/matcher';
import { HOUR, KR_OPEN, MIN, clockNow, makeAgent, makeUser, resetEngineState, restoreEngineState, setClock } from '../engine/helpers';
import { feedMarket, participantOf } from './fixtures';

const SAMSUNG = '005930';

/** A provider that returns the next queued decision (or throws the queued error). */
function scripted(queue: (object | Error)[]): LLMProvider {
  return {
    async decide() {
      const next = queue.shift();
      if (next === undefined) throw new Error('no scripted decision left');
      if (next instanceof Error) throw next;
      return { decision: next as never, raw: JSON.stringify(next) };
    },
  };
}

const buySamsung = { market_view: '반도체 강세', orders: [{ symbol: SAMSUNG, side: 'BUY', quantity: 1, reason: '수급 개선' }] };
const hold = { market_view: '관망', orders: [] };
const tooMany = { market_view: '과욕', orders: [{ symbol: SAMSUNG, side: 'SELL', quantity: 5, reason: '없는 주식 매도' }] };

function league(name: string, agentId: number, extra: { is_public?: boolean; owner_id?: number | null } = {}): { id: number; pid: number } {
  const summary = createLeague({
    name,
    market: 'KR',
    type: 'custom',
    duration_days: 5,
    is_public: extra.is_public ?? true,
    owner_id: extra.owner_id ?? null,
    start_at: KR_OPEN,
    agent_ids: [agentId],
  });
  return { id: summary.id, pid: participantOf(summary.id, agentId) };
}

/** One decision per call, a minute apart, so the order is unambiguous. */
async function decide(pid: number, decision: object | Error): Promise<number> {
  setClock(clockNow() + MIN);
  setProviderResolver(() => scripted([decision]));
  return (await runDecision(pid)).id;
}

let agentId: number;
let a: { id: number; pid: number };
let b: { id: number; pid: number };
let ids: { aBuy: number; aHold: number; bRejected: number; bError: number };

beforeEach(async () => {
  resetEngineState(KR_OPEN + HOUR);
  feedMarket('KR');
  agentId = makeAgent('필터 봇', { provider: 'claude', model: 'test' });
  a = league('리그 A', agentId);
  b = league('리그 B', agentId);
  ids = {
    aBuy: await decide(a.pid, buySamsung),
    bRejected: await decide(b.pid, tooMany),
    aHold: await decide(a.pid, hold),
    bError: await decide(b.pid, new Error('provider down')),
  };
});

afterEach(() => {
  setProviderResolver(null);
  restoreEngineState();
});

describe('listDecisions', () => {
  it('returns every decision of the agent, newest first', () => {
    const page = listDecisions(agentId)!;
    expect(page.decisions.map((d) => d.id)).toEqual([ids.bError, ids.aHold, ids.bRejected, ids.aBuy]);
    expect(page).toMatchObject({ total: 4, next_before: null });
  });

  it('filters by league', () => {
    const page = listDecisions(agentId, { leagueId: a.id })!;
    expect(page.decisions.map((d) => d.id)).toEqual([ids.aHold, ids.aBuy]);
    expect(page.decisions.every((d) => d.league_id === a.id)).toBe(true);
    expect(page.total).toBe(2);
    expect(listDecisions(agentId, { leagueId: 9999 })).toMatchObject({ decisions: [], total: 0, next_before: null });
  });

  it('filters by outcome: traded, hold, and failed (all orders refused, or the decision failed)', () => {
    const only = (result: 'traded' | 'hold' | 'failed') => listDecisions(agentId, { result })!.decisions.map((d) => d.id);
    expect(only('traded')).toEqual([ids.aBuy]);
    expect(only('hold')).toEqual([ids.aHold]);
    expect(only('failed')).toEqual([ids.bError, ids.bRejected]);
    expect(listDecisions(agentId, { leagueId: b.id, result: 'traded' })).toMatchObject({ decisions: [], total: 0 });
  });

  it('pages with the next_before cursor and keeps the filtered total', () => {
    const first = listDecisions(agentId, { limit: 3 })!;
    expect(first.decisions.map((d) => d.id)).toEqual([ids.bError, ids.aHold, ids.bRejected]);
    expect(first).toMatchObject({ total: 4, next_before: ids.bRejected });

    const second = listDecisions(agentId, { limit: 3, before: first.next_before! })!;
    expect(second.decisions.map((d) => d.id)).toEqual([ids.aBuy]);
    expect(second).toMatchObject({ total: 4, next_before: null });

    expect(listDecisions(agentId, { limit: 0 })!.decisions).toHaveLength(1);
    expect(listDecisions(agentId, { limit: DECISION_PAGE_MAX + 50 })!.decisions).toHaveLength(4);
  });

  it('shows what became of each accepted order', () => {
    const before = listDecisions(agentId, { result: 'traded' })!.decisions[0]!;
    expect(before.accepted_orders).toEqual([
      {
        order_id: before.accepted_order_ids[0],
        symbol: SAMSUNG,
        name: '삼성전자',
        side: 'BUY',
        quantity: 1,
        status: 'pending',
        fill_price: null,
        currency: 'KRW',
        filled_at: null,
      },
    ]);

    setClock(clockNow() + MIN);
    matchOrders(feedMarket('KR', { [SAMSUNG]: { price: 51_000 } }));

    const after = listDecisions(agentId, { result: 'traded' })!.decisions[0]!;
    expect(after.accepted_orders[0]).toMatchObject({ status: 'filled', fill_price: 51_000, filled_at: clockNow() });
    // Decisions that placed nothing have no fills.
    expect(listDecisions(agentId, { result: 'failed' })!.decisions.every((d) => d.accepted_orders.length === 0)).toBe(true);
  });

  it('hides decisions of leagues the viewer cannot see', async () => {
    const owner = makeUser('owner');
    const outsider = makeUser('outsider');
    const secret = league('비공개 리그', agentId, { is_public: false, owner_id: owner });
    const secretId = await decide(secret.pid, hold);

    expect(listDecisions(agentId, {}, outsider)!.decisions.map((d) => d.id)).not.toContain(secretId);
    expect(listDecisions(agentId, { leagueId: secret.id }, outsider)).toMatchObject({ decisions: [], total: 0 });
    expect(listDecisions(agentId, { leagueId: secret.id }, owner)!.decisions.map((d) => d.id)).toEqual([secretId]);
    expect(listDecisions(agentId, { leagueId: secret.id })!.total).toBe(1); // admins
  });

  it('is null for an unknown agent', () => {
    expect(listDecisions(9999)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) FROM decision_logs').pluck().get()).toBe(4);
  });
});
