import type { FxQuote, Holding, LeagueMarket, LeagueSummary, Market, Order, Quote } from '../../../shared/api-types';
import { db } from '../../src/db/db';
import { createLeague } from '../../src/engine/leagues';
import type { AgentRow } from '../../src/engine/store';
import { setQuotes } from '../../src/market/quoteCache';
import { getSymbol, symbolsFor } from '../../src/market/symbols';
import type { CandidateRow, DecisionInput } from '../../src/agents/types';
import { clockNow, KR_OPEN, makeAgent, US_OPEN } from '../engine/helpers';

export interface QuoteOverride {
  price?: number;
  change_pct?: number;
  volume?: number;
}

/** Quotes for the whole pool: index i gets price base + i*step and volume (1000 - i) * 1000. */
export function feedMarket(market: Market, overrides: Record<string, QuoteOverride> = {}, ts = clockNow()): Quote[] {
  const base = market === 'KR' ? 50_000 : 100;
  const step = market === 'KR' ? 1_000 : 5;
  const quotes = symbolsFor(market).map((s, i): Quote => ({
    symbol: s.symbol,
    market,
    price: overrides[s.symbol]?.price ?? base + i * step,
    change_pct: overrides[s.symbol]?.change_pct ?? 0,
    volume: overrides[s.symbol]?.volume ?? (1000 - i) * 1000,
    ts,
    source: 'sim',
  }));
  setQuotes(quotes);
  return quotes;
}

/** An active custom league with the given agents (no human owner); returns the agents' participant ids. */
export function agentLeague(
  market: LeagueMarket,
  agents: { name: string; provider?: AgentRow['provider']; model?: string; enabled?: boolean }[],
  overrides: { duration_days?: number; start_at?: number } = {},
): { leagueId: number; participants: Record<string, number>; agentIds: Record<string, number> } {
  const agentIds: Record<string, number> = {};
  for (const a of agents) agentIds[a.name] = makeAgent(a.name, a);
  const league = createLeague({
    name: '에이전트 테스트 리그',
    market,
    type: 'custom',
    duration_days: overrides.duration_days ?? 5,
    is_public: true,
    owner_id: null,
    start_at: overrides.start_at ?? (market === 'US' ? US_OPEN : KR_OPEN),
    agent_ids: Object.values(agentIds),
  });
  const participants: Record<string, number> = {};
  for (const [name, id] of Object.entries(agentIds)) {
    participants[name] = participantOf(league.id, id);
  }
  return { leagueId: league.id, participants, agentIds };
}

export function participantOf(leagueId: number, agentId: number): number {
  return db.prepare('SELECT id FROM participants WHERE league_id = ? AND agent_id = ?').pluck().get(leagueId, agentId) as number;
}

const AGENT: AgentRow = {
  id: 1,
  name: '테스트 봇',
  provider: 'rule',
  model: 'baseline',
  description: '',
  strategy_prompt: '',
  markets: 'KR,US',
  enabled: 1,
  disabled_reason: null,
};

const LEAGUE: LeagueSummary = {
  id: 1,
  name: '테스트 리그',
  type: 'custom',
  market: 'KR',
  currency: 'KRW',
  status: 'active',
  start_at: KR_OPEN,
  end_at: KR_OPEN + 5 * 86_400_000,
  start_cash: 10_000_000,
  decision_interval_min: 60,
  max_orders_per_day: 10,
  fx_spread: 0,
  participant_count: 1,
  ai_count: 1,
  is_public: true,
  joined: false,
  my_participant_id: null,
  left: false,
};

export function candidate(symbol: string, price: number | null, extra: Partial<CandidateRow> = {}): CandidateRow {
  const market = getSymbol(symbol)?.market ?? 'KR';
  return { symbol, name: symbol, market, market_open: true, kind: 'stock', leverage: 1, price, change_pct: 0, volume: 1000, closes_5d: [], ...extra };
}

export function holding(symbol: string, quantity: number, price: number): Holding {
  const value = quantity * price;
  const currency = getSymbol(symbol)?.market === 'US' ? 'USD' : 'KRW';
  return { symbol, name: symbol, currency, quantity, avg_price: price, price, fx_rate: 1, value, pnl: 0, pnl_rate: 0 };
}

/** A self-contained DecisionInput for pure strategy and prompt tests (no database). */
export function pureInput(
  opts: {
    cash?: number;
    availableCash?: number;
    holdings?: Holding[];
    candidates?: CandidateRow[];
    pendingOrders?: Order[];
    ordersToday?: number;
    maxOrders?: number;
    agent?: Partial<AgentRow>;
    league?: Partial<LeagueSummary>;
    rules?: Partial<DecisionInput['rules']>;
    marketsOpen?: DecisionInput['marketsOpen'];
    fx?: FxQuote | null;
  } = {},
): DecisionInput {
  const cash = opts.cash ?? 10_000_000;
  const holdings = opts.holdings ?? [];
  const equity = cash + holdings.reduce((s, h) => s + h.value, 0);
  const league = { ...LEAGUE, ...opts.league };
  return {
    agent: { ...AGENT, ...opts.agent },
    league,
    rules: {
      fee_rate: 0.00015,
      tax_rate: 0.002,
      fx_spread: 0,
      rates: { KR: { fee_rate: 0.00015, tax_rate: 0.002 } },
      ...opts.rules,
    },
    portfolio: {
      participant_id: 1,
      league_id: league.id,
      currency: league.currency,
      cash,
      available_cash: opts.availableCash ?? cash,
      equity,
      return_rate: equity / league.start_cash - 1,
      holdings,
      orders_today: opts.ordersToday ?? 0,
      max_orders_per_day: opts.maxOrders ?? league.max_orders_per_day,
      fx: opts.fx ?? null,
    },
    pendingOrders: opts.pendingOrders ?? [],
    candidates: opts.candidates ?? [],
    marketOpen: true,
    marketsOpen: opts.marketsOpen ?? { KR: true },
    fx: opts.fx ?? null,
    now: KR_OPEN + 3_600_000,
  };
}
