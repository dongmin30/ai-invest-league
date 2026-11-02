import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_MOVERS,
  CORE_CANDIDATES,
  getAgentDetail,
  isDecisionRunning,
  listAgents,
  MAX_CANDIDATES,
  MAX_LEVERAGED_CANDIDATES,
  runDecision,
  runDueAgents,
  selectCandidates,
  setProviderResolver,
} from '../../src/agents/runner';
import { AgentError, type DecisionInput, type LLMProvider } from '../../src/agents/types';
import { config } from '../../src/config';
import { db } from '../../src/db/db';
import { matchOrders } from '../../src/engine/matcher';
import { getPortfolio } from '../../src/engine/portfolio';
import { bus } from '../../src/lib/bus';
import { getSymbol, isLeveraged, symbolsFor } from '../../src/market/symbols';
import { HOUR, KR_CLOSE, KR_OPEN, MIN, makeUser, resetEngineState, restoreEngineState, setClock, US_OPEN } from '../engine/helpers';
import { agentLeague, feedMarket } from './fixtures';

const defaultTimeout = config.agentTimeoutSec;

function fixed(decision: unknown, extra: { input_tokens?: number; output_tokens?: number } = {}): LLMProvider & {
  inputs: DecisionInput[];
} {
  const inputs: DecisionInput[] = [];
  return {
    inputs,
    async decide(input) {
      inputs.push(input);
      return { decision: decision as never, raw: JSON.stringify(decision), ...extra };
    },
  };
}

function orderCount(participantId: number): number {
  return db.prepare('SELECT COUNT(*) FROM orders WHERE participant_id = ?').pluck().get(participantId) as number;
}

function logRow(id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM decision_logs WHERE id = ?').get(id) as Record<string, unknown>;
}

beforeEach(() => {
  resetEngineState(KR_OPEN + HOUR);
  feedMarket('KR');
});

afterEach(() => {
  setProviderResolver(null);
  config.agentTimeoutSec = defaultTimeout;
  restoreEngineState();
});

describe('selectCandidates', () => {
  it('caps the list, starts with the core index ETFs and is the same for agents with the same portfolio', () => {
    const { participants } = agentLeague('KR', [{ name: 'A' }, { name: 'B' }]);
    const a = selectCandidates({ market: 'KR' }, getPortfolio(participants.A!));
    const b = selectCandidates({ market: 'KR' }, getPortfolio(participants.B!));
    expect(a).toEqual(b);
    expect(symbolsFor('KR').length).toBeGreaterThan(MAX_CANDIDATES);
    expect(a).toHaveLength(MAX_CANDIDATES);
    expect(new Set(a.map((c) => c.symbol)).size).toBe(a.length);
    expect(a.slice(0, CORE_CANDIDATES.KR.length).map((c) => c.symbol)).toEqual(CORE_CANDIDATES.KR);
    expect(a.find((c) => c.symbol === '005930')).toMatchObject({
      name: '삼성전자',
      kind: 'stock',
      leverage: 1,
      price: 50_000,
      change_pct: 0,
      closes_5d: [],
    });
    expect(a.find((c) => c.symbol === '069500')).toMatchObject({ kind: 'etf', leverage: 1 });
  });

  it('always includes holdings and pending-order symbols, then movers (normalized by leverage), then traded value', () => {
    const pool = symbolsFor('KR');
    const stocks = pool.filter((s) => s.kind === 'stock');
    const last = stocks.at(-1)!.symbol; // lowest fixture volume and price rank
    const held = stocks.at(-2)!.symbol;
    const pending = stocks.at(-3)!.symbol;
    // 3× the KOSPI 200 is not a bigger mover than a stock moving 5% just for being leveraged.
    feedMarket('KR', {
      [last]: { change_pct: 5 },
      '122630': { change_pct: 4 }, // 2×: normalized 2%
      '252670': { change_pct: -4 }, // -2×: normalized 2%
      '352820': { volume: 1e9 }, // top traded value (not a mover)
    });
    const portfolio = {
      ...getPortfolio(agentLeague('KR', [{ name: 'A' }]).participants.A!),
      holdings: [{ symbol: held, name: held, currency: 'KRW' as const, quantity: 1, avg_price: 1, price: 1, fx_rate: 1, value: 1, pnl: 0, pnl_rate: 0 }],
    };
    const list = selectCandidates({ market: 'KR' }, portfolio, [
      { symbol: pending, status: 'pending' },
      { symbol: '000660', status: 'filled' },
    ]).map((c) => c.symbol);

    expect(list.slice(0, 2)).toEqual([held, pending]);
    expect(list.slice(2, 2 + CORE_CANDIDATES.KR.length)).toEqual(CORE_CANDIDATES.KR);
    // The 5% mover ranks first among the movers, ahead of both 2× ETFs.
    expect(list[2 + CORE_CANDIDATES.KR.length]).toBe(last);
    expect(list.indexOf(last)).toBeLessThan(list.indexOf('122630'));
    expect(list).toHaveLength(MAX_CANDIDATES);
    // Highest traded value fills the rest (fixture: first symbols have the most volume).
    expect(list).toContain('352820');
    expect(CANDIDATE_MOVERS).toBeLessThan(MAX_CANDIDATES);
  });

  it('admits at most MAX_LEVERAGED_CANDIDATES leveraged/inverse ETFs through ranking', () => {
    const levered = symbolsFor('US').filter(isLeveraged);
    expect(levered.length).toBeGreaterThan(MAX_LEVERAGED_CANDIDATES);
    setClock(US_OPEN + HOUR);
    feedMarket('US', Object.fromEntries(levered.map((s) => [s.symbol, { change_pct: 30, volume: 1e9 }])));
    const { participants } = agentLeague('US', [{ name: 'A' }]);
    const list = selectCandidates({ market: 'US' }, getPortfolio(participants.A!));
    expect(list.filter((c) => isLeveraged(getSymbol(c.symbol)!))).toHaveLength(MAX_LEVERAGED_CANDIDATES);
    expect(list).toHaveLength(MAX_CANDIDATES);
  });
});

describe('runDecision', () => {
  it('places valid orders, rejects unknown symbols, and logs the decision', async () => {
    const { leagueId, participants, agentIds } = agentLeague('KR', [{ name: 'LLM', provider: 'claude', model: 'm' }]);
    const pid = participants.LLM!;
    const provider = fixed(
      {
        market_view: '관망보다 매수',
        orders: [
          { symbol: '005930', side: 'BUY', quantity: 10, reason: '대형주' },
          { symbol: 'AAPL', side: 'BUY', quantity: 1, reason: '다른 시장' },
          { symbol: 'ZZZZ', side: 'BUY', quantity: 1, reason: '없는 종목' },
          { symbol: '000660', side: 'SELL', quantity: 1, reason: '보유 없음' },
        ],
      },
      { input_tokens: 1200, output_tokens: 80 },
    );
    setProviderResolver(() => provider);
    const events: unknown[] = [];
    const listener = (e: unknown) => events.push(e);
    bus.on('decision', listener);

    const log = await runDecision(pid);
    bus.off('decision', listener);

    expect(log.status).toBe('ok');
    expect(log.accepted_order_ids).toHaveLength(1);
    expect(log.rejected).toEqual([
      { symbol: 'AAPL', reason: 'unknown_symbol' },
      { symbol: 'ZZZZ', reason: 'unknown_symbol' },
      { symbol: '000660', reason: 'insufficient_shares' },
    ]);
    expect(log.orders).toHaveLength(4);
    expect(log).toMatchObject({ input_tokens: 1200, output_tokens: 80, league_id: leagueId, agent_id: agentIds.LLM });
    expect(orderCount(pid)).toBe(1);

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(log.accepted_order_ids[0]) as Record<string, unknown>;
    expect(order).toMatchObject({ symbol: '005930', side: 'BUY', type: 'MARKET', quantity: 10, source: 'agent' });

    const row = logRow(log.id);
    expect(row.prompt_summary).toContain(`후보 ${MAX_CANDIDATES}종목`);
    expect(String(row.raw_response)).toContain('005930');
    const lastDecision = db.prepare('SELECT last_decision_at FROM participants WHERE id = ?').pluck().get(pid);
    expect(lastDecision).toBe(KR_OPEN + HOUR);
    expect(events).toEqual([
      expect.objectContaining({ league_id: leagueId, agent_id: agentIds.LLM, agent_name: 'LLM', status: 'ok' }),
    ]);
    expect(provider.inputs[0]!.rules).toEqual({
      fee_rate: 0.00015,
      tax_rate: 0.002,
      max_position_pct: 0.4,
      fx_spread: 0,
      rates: { KR: { fee_rate: 0.00015, tax_rate: 0.002 } },
    });
  });

  it('logs hold when the agent proposes no orders', async () => {
    const { participants } = agentLeague('KR', [{ name: 'LLM', provider: 'claude' }]);
    setProviderResolver(() => fixed({ market_view: '관망', orders: [] }));
    const log = await runDecision(participants.LLM!);
    expect(log.status).toBe('hold');
    expect(log.market_view).toBe('관망');
    expect(orderCount(participants.LLM!)).toBe(0);
  });

  it('records a timeout as a HOLD log with no orders', async () => {
    const { participants } = agentLeague('KR', [{ name: 'Slow', provider: 'ollama' }]);
    config.agentTimeoutSec = 0.05;
    let sawAbort = false;
    setProviderResolver(() => ({
      decide: (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(signal.reason);
          });
        }),
    }));
    const log = await runDecision(participants.Slow!);
    expect(log.status).toBe('timeout');
    expect(log.orders).toEqual([]);
    expect(log.accepted_order_ids).toEqual([]);
    expect(log.error).toContain('응답하지 않았습니다');
    expect(sawAbort).toBe(true);
    expect(orderCount(participants.Slow!)).toBe(0);
  });

  it('times out even when the provider ignores the abort signal', async () => {
    const { participants } = agentLeague('KR', [{ name: 'Stuck', provider: 'ollama' }]);
    config.agentTimeoutSec = 0.05;
    setProviderResolver(() => ({ decide: () => new Promise(() => {}) }));
    const log = await runDecision(participants.Stuck!);
    expect(log.status).toBe('timeout');
  });

  it('records invalid output and provider errors without placing orders', async () => {
    const { participants } = agentLeague('KR', [{ name: 'Bad', provider: 'claude' }]);
    const pid = participants.Bad!;

    setProviderResolver(() => ({
      decide: async () => {
        throw new AgentError('invalid', '응답이 올바른 JSON이 아닙니다.', 'garbage');
      },
    }));
    const invalid = await runDecision(pid);
    expect(invalid).toMatchObject({ status: 'invalid', orders: [], accepted_order_ids: [] });
    expect(logRow(invalid.id).raw_response).toBe('garbage');

    setProviderResolver(() => ({
      decide: async () => {
        throw new Error('boom');
      },
    }));
    const failed = await runDecision(pid);
    expect(failed).toMatchObject({ status: 'error', error: 'boom' });
    expect(orderCount(pid)).toBe(0);
  });

  it('truncates the stored raw response to 8000 characters', async () => {
    const { participants } = agentLeague('KR', [{ name: 'Verbose', provider: 'claude' }]);
    setProviderResolver(() => ({
      decide: async () => ({ decision: { market_view: '', orders: [] }, raw: 'x'.repeat(20_000) }),
    }));
    const log = await runDecision(participants.Verbose!);
    expect(String(logRow(log.id).raw_response).length).toBe(8000);
  });

  it('runs the real baseline strategy and every order is accepted', async () => {
    const { participants } = agentLeague('KR', [{ name: '기준선', provider: 'rule', model: 'baseline' }]);
    const pid = participants['기준선']!;
    const first = await runDecision(pid);
    expect(first.status).toBe('ok');
    expect(first.accepted_order_ids).toHaveLength(5);
    expect(first.rejected).toEqual([]);

    setClock(KR_OPEN + HOUR + MIN);
    matchOrders(feedMarket('KR'));
    const second = await runDecision(pid);
    expect(second.status).toBe('ok');
    expect(second.accepted_order_ids).toHaveLength(5);
    expect(second.rejected).toEqual([]);

    setClock(KR_OPEN + HOUR + 2 * MIN);
    matchOrders(feedMarket('KR'));
    const portfolio = getPortfolio(pid);
    expect(portfolio.holdings).toHaveLength(10);
    expect(portfolio.cash / portfolio.equity).toBeGreaterThan(0.04);
    expect(portfolio.cash / portfolio.equity).toBeLessThan(0.1);

    setClock(KR_OPEN + 3 * HOUR);
    const third = await runDecision(pid);
    expect(third.status).toBe('hold');
  });

  it('runs the real momentum strategy against the engine', async () => {
    const { participants } = agentLeague('KR', [{ name: '모멘텀', provider: 'rule', model: 'momentum' }]);
    feedMarket('KR', { '000660': { change_pct: 3 }, '005380': { change_pct: 2 }, '000270': { change_pct: 5 } });
    const log = await runDecision(participants['모멘텀']!);
    expect(log.status).toBe('ok');
    expect(log.orders.map((o) => o.symbol)).toEqual(['000270', '000660']);
    expect(log.rejected).toEqual([]);
  });

  it('throws not_found for a human participant', async () => {
    const human = db
      .prepare("INSERT INTO users (email, password_hash, nickname, created_at) VALUES ('h@x.dev', 'x', 'h', 0)")
      .run().lastInsertRowid;
    const { leagueId } = agentLeague('KR', [{ name: 'A' }]);
    const pid = db
      .prepare('INSERT INTO participants (league_id, user_id, cash, joined_at) VALUES (?, ?, 1, 0)')
      .run(leagueId, human).lastInsertRowid;
    await expect(runDecision(Number(pid))).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('runDueAgents', () => {
  it('runs due agents once per interval, only while the market is open, and skips disabled agents', async () => {
    const { participants } = agentLeague('KR', [
      { name: 'On', provider: 'claude' },
      { name: 'Off', provider: 'claude', enabled: false },
    ]);
    const provider = fixed({ market_view: '관망', orders: [] });
    setProviderResolver(() => provider);

    await runDueAgents();
    expect(provider.inputs.map((i) => i.agent.name)).toEqual(['On']);

    setClock(KR_OPEN + HOUR + 30 * MIN);
    await runDueAgents();
    expect(provider.inputs).toHaveLength(1);

    setClock(KR_OPEN + 2 * HOUR);
    await runDueAgents();
    expect(provider.inputs).toHaveLength(2);

    setClock(KR_CLOSE + HOUR);
    await runDueAgents();
    expect(provider.inputs).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) FROM decision_logs WHERE participant_id = ?').pluck().get(participants.Off)).toBe(0);
  });

  it('never throws, runs sequentially, and keeps going after a failing agent', async () => {
    agentLeague('KR', [
      { name: 'Boom', provider: 'claude' },
      { name: 'Fine', provider: 'claude' },
    ]);
    let active = 0;
    let maxActive = 0;
    const seen: string[] = [];
    setProviderResolver((agent) => ({
      async decide() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        seen.push(agent.name);
        if (agent.name === 'Boom') throw new Error('provider down');
        return { decision: { market_view: '', orders: [] }, raw: '{}' };
      },
    }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runDueAgents()).resolves.toBeUndefined();
    errors.mockRestore();
    expect(seen).toEqual(['Boom', 'Fine']);
    expect(maxActive).toBe(1);
    const statuses = db.prepare('SELECT status FROM decision_logs ORDER BY id').pluck().all();
    expect(statuses).toEqual(['error', 'hold']);
  });
});

describe('agent info', () => {
  it('lists agents and shows participations and recent decisions', async () => {
    const { leagueId, participants, agentIds } = agentLeague('KR', [{ name: '기준선', provider: 'rule', model: 'baseline' }]);
    await runDecision(participants['기준선']!);

    const info = listAgents().find((a) => a.id === agentIds['기준선']);
    expect(info).toMatchObject({ provider: 'rule', model: 'baseline', enabled: true, disabled_reason: null, markets: ['KR', 'US'] });

    const detail = getAgentDetail(agentIds['기준선']!)!;
    expect(detail.participations).toEqual([
      expect.objectContaining({ league_id: leagueId, participant_id: participants['기준선'], rank: null }),
    ]);
    expect(detail.recent_decisions).toHaveLength(1);
    expect(detail.recent_decisions[0]!.orders).toHaveLength(5);
    expect(getAgentDetail(9999)).toBeNull();
  });
});

describe('decision guards', () => {
  it('validates every provider result against DecisionSchema, rule strategies included', async () => {
    const { participants } = agentLeague('KR', [{ name: 'Rule', provider: 'rule', model: 'baseline' }]);
    const pid = participants.Rule!;
    const symbols = symbolsFor('KR').slice(0, 6).map((s) => s.symbol);
    setProviderResolver(() =>
      fixed({ market_view: '', orders: symbols.map((symbol) => ({ symbol, side: 'BUY', quantity: 1, reason: '' })) }),
    );
    const log = await runDecision(pid);
    expect(log).toMatchObject({ status: 'invalid', orders: [], accepted_order_ids: [] });
    expect(orderCount(pid)).toBe(0);
  });

  it('refuses a second decision for a participant while one is running, and runDueAgents skips it', async () => {
    const { participants } = agentLeague('KR', [{ name: 'Slow', provider: 'claude' }]);
    const pid = participants.Slow!;
    let release: () => void = () => {};
    let calls = 0;
    setProviderResolver(() => ({
      decide: async () => {
        calls++;
        await new Promise<void>((resolve) => (release = resolve));
        return { decision: { market_view: '', orders: [] }, raw: '{}' };
      },
    }));

    const running = runDecision(pid);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(isDecisionRunning(pid)).toBe(true);
    await expect(runDecision(pid)).rejects.toMatchObject({ code: 'agent_busy' });
    await runDueAgents();
    expect(calls).toBe(1);

    release();
    expect((await running).status).toBe('hold');
    expect(isDecisionRunning(pid)).toBe(false);
  });

  it('hides private-league participations and decisions from users who cannot see the league', async () => {
    const { leagueId, participants, agentIds } = agentLeague('KR', [{ name: '기준선', provider: 'rule', model: 'baseline' }]);
    db.prepare('UPDATE leagues SET is_public = 0 WHERE id = ?').run(leagueId);
    await runDecision(participants['기준선']!);
    const outsider = makeUser('outsider');
    const member = makeUser('member');
    db.prepare('INSERT INTO participants (league_id, user_id, cash, joined_at) VALUES (?, ?, 1, 0)').run(leagueId, member);

    const hidden = getAgentDetail(agentIds['기준선']!, outsider)!;
    expect(hidden.participations).toEqual([]);
    expect(hidden.recent_decisions).toEqual([]);

    for (const detail of [getAgentDetail(agentIds['기준선']!, member)!, getAgentDetail(agentIds['기준선']!)!]) {
      expect(detail.participations.map((p) => p.league_id)).toEqual([leagueId]);
      expect(detail.recent_decisions).toHaveLength(1);
    }
  });
});
