import { ZodError } from 'zod';
import type {
  AgentDetail,
  AgentInfo,
  DecisionLog,
  DecisionOrder,
  LeagueSummary,
  Market,
  Order,
  Portfolio,
  Quote,
} from '../../../shared/api-types';
import { config } from '../config';
import { EngineError } from '../engine/errors';
import { LEAGUE_DEFAULTS } from '../engine/fees';
import { getLeagueSummary } from '../engine/leagues';
import { listOrders, placeOrder } from '../engine/orders';
import { getPortfolio } from '../engine/portfolio';
import { computeRankings } from '../engine/ranking';
import { agentMarkets, getLeagueRow, getParticipantRow, sql, type AgentRow, type LeagueRow } from '../engine/store';
import { bus } from '../lib/bus';
import { now } from '../lib/time';
import { isLeagueOpen, isMarketOpen } from '../market/calendar';
import { getDailyCloses } from '../market/collector';
import { getFx } from '../market/fx';
import { getQuote } from '../market/quoteCache';
import { getSymbol, isLeveraged, symbolsFor, type SymbolInfo } from '../market/symbols';
import { summarizePrompt } from './prompt';
import { createClaudeProvider } from './providers/claude';
import { createOllamaProvider } from './providers/ollama';
import { DecisionSchema, type Decision } from './schema';
import { createBaselineStrategy } from './strategies/baseline';
import { createMomentumStrategy } from './strategies/momentum';
import { AgentError, type CandidateRow, type DecisionInput, type LLMProvider } from './types';

const RAW_LIMIT = 8000;
const SUMMARY_LIMIT = 120;
const RECENT_DECISIONS = 50;
const PARTICIPATIONS_LIMIT = 30;

type ProviderResolver = (agent: AgentRow) => LLMProvider;

const defaultResolver: ProviderResolver = (agent) => {
  switch (agent.provider) {
    case 'claude':
      return createClaudeProvider();
    case 'ollama':
      return createOllamaProvider();
    case 'rule':
      if (agent.model === 'baseline') return createBaselineStrategy();
      if (agent.model === 'momentum') return createMomentumStrategy();
      throw new AgentError('error', `알 수 없는 규칙 전략: ${agent.model}`);
  }
};

let resolver: ProviderResolver = defaultResolver;

/** Tests only: replace how agents map to providers (`null` restores the default). */
export function setProviderResolver(fn: ProviderResolver | null): void {
  resolver = fn ?? defaultResolver;
}

// ---- candidates ----

/** Candidates per decision; held and pending-order symbols are always included, even beyond it. */
export const MAX_CANDIDATES = 40;
/** How many top movers (|change_pct| / |leverage|) enter before the list is filled by traded value. */
export const CANDIDATE_MOVERS = 15;
/** Leveraged/inverse ETFs added by ranking (held or pending ones are always shown). */
export const MAX_LEVERAGED_CANDIDATES = 6;
/** Index ETFs every agent always sees. */
export const CORE_CANDIDATES: Record<Market, string[]> = {
  KR: ['069500', '229200'],
  US: ['SPY', 'QQQ', 'DIA', 'IWM'],
};
/** ALL leagues: share of the ranked slots for the open market when exactly one is open (else half each). */
export const OPEN_MARKET_SHARE = 0.6;
/** ALL leagues: movers and leveraged ETFs per market, [primary (open, or KR), other]. */
export const ALL_MOVERS_SPLIT: [number, number] = [9, 6];
export const ALL_LEVERAGED_SPLIT: [number, number] = [3, 3];

function candidateRow(symbol: string, leagueMarket: LeagueSummary['market'], at: number, fxRate: number | undefined): CandidateRow {
  const info = getSymbol(symbol);
  const q = getQuote(symbol);
  const market = info?.market ?? 'KR';
  const price = q?.price ?? null;
  const priceKrw = price === null ? null : market === 'KR' ? price : fxRate === undefined ? null : Math.round(price * fxRate);
  return {
    symbol,
    name: info?.name ?? symbol,
    market,
    market_open: isMarketOpen(market, at),
    kind: info?.kind ?? 'stock',
    leverage: info?.leverage ?? 1,
    ...(info?.underlying ? { underlying: info.underlying } : {}),
    price,
    change_pct: q ? Number(q.change_pct.toFixed(2)) : null,
    volume: q?.volume ?? null,
    closes_5d: getDailyCloses(symbol, 5),
    ...(leagueMarket === 'ALL' ? { price_krw: priceKrw } : {}),
  };
}

interface RankBudget {
  /** Symbols this call may add. */
  slots: number;
  movers: number;
  leveraged: number;
}

/**
 * Adds up to `budget.slots` symbols of one market's pool to `picked`: the top movers by
 * |change_pct| / |leverage| (a 3× ETF does not outrank its index just for being 3×), then
 * the highest traded value (price × volume, within this market only), then pool order for
 * unquoted symbols. At most `budget.leveraged` leveraged/inverse ETFs enter. Ties by symbol.
 */
function rankMarket(pool: SymbolInfo[], picked: string[], budget: RankBudget): void {
  let added = 0;
  let leveraged = 0;
  const take = (info: SymbolInfo): boolean => {
    if (added >= budget.slots || picked.includes(info.symbol)) return false;
    if (isLeveraged(info)) {
      if (leveraged >= budget.leveraged) return false;
      leveraged++;
    }
    picked.push(info.symbol);
    added++;
    return true;
  };

  const quoted = pool.flatMap((info) => {
    const q = getQuote(info.symbol);
    return q && q.price > 0 ? [{ info, q }] : [];
  });
  const bySymbol = (a: { info: SymbolInfo }, b: { info: SymbolInfo }) => a.info.symbol.localeCompare(b.info.symbol);
  const move = (x: { info: SymbolInfo; q: Quote }) => Math.abs(x.q.change_pct) / Math.max(1, Math.abs(x.info.leverage));

  let movers = 0;
  for (const x of [...quoted].sort((a, b) => move(b) - move(a) || bySymbol(a, b))) {
    if (movers >= budget.movers) break;
    if (take(x.info)) movers++;
  }
  for (const x of [...quoted].sort((a, b) => b.q.price * b.q.volume - a.q.price * a.q.volume || bySymbol(a, b))) {
    take(x.info);
  }
  for (const info of pool) take(info);
}

/**
 * The symbols one decision sees, so the prompt stays small with a 100–270 symbol pool:
 * holdings and pending-order symbols, the core index ETFs, then rankMarket (CANDIDATE_MOVERS
 * movers, traded value, pool order) up to MAX_CANDIDATES, with at most MAX_LEVERAGED_CANDIDATES
 * leveraged/inverse ETFs entering by ranking.
 * ALL leagues: core ETFs of both markets, then the remaining slots R = MAX_CANDIDATES − forced
 * are split ceil(R × OPEN_MARKET_SHARE) for the open market / the rest for the closed one
 * (half each when both or neither are open; KR first), movers 9/6 and leveraged 3/3.
 * Deterministic; held/pending symbols are always included; orders are still validated against
 * the whole pool.
 */
export function selectCandidates(
  league: Pick<LeagueSummary, 'market'>,
  portfolio: Portfolio,
  pendingOrders: Pick<Order, 'symbol' | 'status'>[] = [],
  at: number = now(),
): CandidateRow[] {
  const picked: string[] = [];
  const forced = (symbol: string) => {
    if (!picked.includes(symbol)) picked.push(symbol);
  };
  for (const h of portfolio.holdings) forced(h.symbol);
  for (const o of pendingOrders) if (o.status === 'pending') forced(o.symbol);
  const markets: Market[] = league.market === 'ALL' ? ['KR', 'US'] : [league.market];
  for (const m of markets) for (const symbol of CORE_CANDIDATES[m]) if (getSymbol(symbol)?.market === m) forced(symbol);

  const slots = Math.max(0, MAX_CANDIDATES - picked.length);
  if (league.market !== 'ALL') {
    rankMarket(symbolsFor(league.market), picked, { slots, movers: CANDIDATE_MOVERS, leveraged: MAX_LEVERAGED_CANDIDATES });
  } else {
    const krOpen = isMarketOpen('KR', at);
    const usOpen = isMarketOpen('US', at);
    const [primary, other]: Market[] = krOpen || !usOpen ? ['KR', 'US'] : ['US', 'KR'];
    const primarySlots = krOpen !== usOpen ? Math.ceil(slots * OPEN_MARKET_SHARE) : Math.ceil(slots / 2);
    rankMarket(symbolsFor(primary!), picked, {
      slots: primarySlots,
      movers: ALL_MOVERS_SPLIT[0],
      leveraged: ALL_LEVERAGED_SPLIT[0],
    });
    rankMarket(symbolsFor(other!), picked, {
      slots: slots - primarySlots,
      movers: ALL_MOVERS_SPLIT[1],
      leveraged: ALL_LEVERAGED_SPLIT[1],
    });
  }

  const fxRate = league.market === 'ALL' ? getFx(at)?.rate : undefined;
  return picked.map((symbol) => candidateRow(symbol, league.market, at, fxRate));
}

// ---- decision logs ----

interface DecisionLogRow {
  id: number;
  agent_id: number;
  participant_id: number;
  league_id: number;
  ts: number;
  status: DecisionLog['status'];
  market_view: string;
  orders_json: string;
  accepted_order_ids_json: string;
  rejected_json: string;
  prompt_summary: string;
  raw_response: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toDecisionLog(row: DecisionLogRow): DecisionLog {
  return {
    id: row.id,
    agent_id: row.agent_id,
    participant_id: row.participant_id,
    league_id: row.league_id,
    ts: row.ts,
    market_view: row.market_view,
    orders: parseJson<DecisionOrder[]>(row.orders_json, []),
    accepted_order_ids: parseJson<number[]>(row.accepted_order_ids_json, []),
    rejected: parseJson<{ symbol: string; reason: string }[]>(row.rejected_json, []),
    status: row.status,
    error: row.error,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    latency_ms: row.latency_ms,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---- running a decision ----

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rejects once `signal` aborts, so a provider that ignores the signal still cannot overrun. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

interface Outcome {
  status: DecisionLog['status'];
  decision: Decision | null;
  accepted: number[];
  rejected: { symbol: string; reason: string }[];
  raw: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

function failure(status: 'invalid' | 'error' | 'timeout', error: string, raw: string | null = null): Outcome {
  return { status, decision: null, accepted: [], rejected: [], raw, error, input_tokens: null, output_tokens: null };
}

function classify(err: unknown, signal: AbortSignal): Outcome {
  if (signal.aborted) return failure('timeout', `${config.agentTimeoutSec}초 안에 응답하지 않았습니다.`);
  if (err instanceof AgentError) return failure(err.kind, err.message, err.raw ?? null);
  if (err instanceof ZodError || err instanceof SyntaxError) return failure('invalid', errorMessage(err));
  return failure('error', errorMessage(err));
}

function placeDecisionOrders(participantId: number, decision: Decision, allowed: Set<string>): Pick<Outcome, 'accepted' | 'rejected'> {
  const accepted: number[] = [];
  const rejected: { symbol: string; reason: string }[] = [];
  for (const o of decision.orders) {
    const symbol = o.symbol.trim().toUpperCase();
    if (!allowed.has(symbol)) {
      rejected.push({ symbol: o.symbol, reason: 'unknown_symbol' });
      continue;
    }
    try {
      const order = placeOrder(participantId, { symbol, side: o.side, type: 'MARKET', quantity: o.quantity }, 'agent');
      accepted.push(order.id);
    } catch (err) {
      rejected.push({ symbol, reason: err instanceof EngineError ? err.code : 'error' });
      if (!(err instanceof EngineError)) console.error('[agents] placeOrder failed:', err);
    }
  }
  return { accepted, rejected };
}

function loadAiParticipant(participantId: number): { agent: AgentRow; league: LeagueRow } {
  const participant = getParticipantRow(participantId);
  const league = participant && getLeagueRow(participant.league_id);
  const agent =
    participant?.agent_id != null
      ? (sql('SELECT * FROM agents WHERE id = ?').get(participant.agent_id) as AgentRow | undefined)
      : undefined;
  if (!participant || !league || !agent) throw new EngineError('not_found', 'AI 참가자를 찾을 수 없습니다.');
  return { agent, league };
}

export function buildDecisionInput(participantId: number): DecisionInput {
  const { agent, league } = loadAiParticipant(participantId);
  const summary = getLeagueSummary(league.id, null)!;
  const portfolio = getPortfolio(participantId);
  const pendingOrders = listOrders(participantId, 'pending');
  const at = now();
  const markets: Market[] = league.market === 'ALL' ? ['KR', 'US'] : [league.market];
  const rates = (m: Market) =>
    league.market === 'ALL'
      ? { fee_rate: LEAGUE_DEFAULTS[m].fee_rate, tax_rate: LEAGUE_DEFAULTS[m].tax_rate }
      : { fee_rate: league.fee_rate, tax_rate: league.tax_rate };
  return {
    agent,
    league: summary,
    rules: {
      fee_rate: league.fee_rate,
      tax_rate: league.tax_rate,
      max_position_pct: league.max_position_pct,
      fx_spread: league.fx_spread,
      rates: Object.fromEntries(markets.map((m) => [m, rates(m)])),
    },
    portfolio,
    pendingOrders,
    candidates: selectCandidates(summary, portfolio, pendingOrders, at),
    marketOpen: isLeagueOpen(league.market, at),
    marketsOpen: Object.fromEntries(markets.map((m) => [m, isMarketOpen(m, at)])),
    fx: league.market === 'ALL' ? getFx(at) : null,
    now: at,
  };
}

const inFlight = new Set<number>();

/** Whether a decision for this participant is running right now. */
export function isDecisionRunning(participantId: number): boolean {
  return inFlight.has(participantId);
}

/**
 * Asks the participant's agent for a decision and places the resulting MARKET orders.
 * Every provider's output (rule strategies included) is validated against DecisionSchema.
 * Provider failures are recorded (invalid / error / timeout) and place no orders.
 * Throws EngineError('not_found') when the participant is not an AI participant, and
 * EngineError('agent_busy') while another decision for the same participant is running.
 */
export async function runDecision(participantId: number): Promise<DecisionLog> {
  if (inFlight.has(participantId)) {
    throw new EngineError('agent_busy', '이 에이전트는 이미 판단 중입니다. 잠시 후 다시 시도해 주세요.');
  }
  inFlight.add(participantId);
  try {
    return await decideAndRecord(participantId);
  } finally {
    inFlight.delete(participantId);
  }
}

async function decideAndRecord(participantId: number): Promise<DecisionLog> {
  const input = buildDecisionInput(participantId);
  const { agent, league } = input;
  const started = performance.now();
  const signal = AbortSignal.timeout(config.agentTimeoutSec * 1000);

  let outcome: Outcome;
  try {
    const result = await raceAbort(Promise.resolve().then(() => resolver(agent).decide(input, signal)), signal);
    const decision = DecisionSchema.parse(result.decision);
    // The whole league pool is tradable, not only the candidates shown this time (ALL: every symbol).
    const allowed = new Set([
      ...symbolsFor(league.market).map((s) => s.symbol),
      ...input.portfolio.holdings.map((h) => h.symbol),
    ]);
    const placed = placeDecisionOrders(participantId, decision, allowed);
    outcome = {
      status: decision.orders.length === 0 ? 'hold' : 'ok',
      decision,
      ...placed,
      raw: result.raw,
      error: null,
      input_tokens: result.input_tokens ?? null,
      output_tokens: result.output_tokens ?? null,
    };
  } catch (err) {
    outcome = classify(err, signal);
  }

  const latency = Math.round(performance.now() - started);
  const ts = now();
  const id = Number(
    sql(
      `INSERT INTO decision_logs (agent_id, participant_id, league_id, ts, status, market_view, orders_json,
                                  accepted_order_ids_json, rejected_json, prompt_summary, raw_response, error,
                                  input_tokens, output_tokens, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agent.id,
      participantId,
      league.id,
      ts,
      outcome.status,
      outcome.decision?.market_view ?? '',
      JSON.stringify(outcome.decision?.orders ?? []),
      JSON.stringify(outcome.accepted),
      JSON.stringify(outcome.rejected),
      truncate(summarizePrompt(input), 500),
      outcome.raw === null ? null : truncate(outcome.raw, RAW_LIMIT),
      outcome.error === null ? null : truncate(outcome.error, 1000),
      outcome.input_tokens,
      outcome.output_tokens,
      latency,
    ).lastInsertRowid,
  );
  sql('UPDATE participants SET last_decision_at = ? WHERE id = ?').run(ts, participantId);

  const log = toDecisionLog(sql('SELECT * FROM decision_logs WHERE id = ?').get(id) as DecisionLogRow);
  bus.emit('decision', {
    league_id: league.id,
    agent_id: agent.id,
    agent_name: agent.name,
    status: log.status,
    summary: decisionSummary(log),
  });
  return log;
}

function decisionSummary(log: DecisionLog): string {
  switch (log.status) {
    case 'ok':
      return truncate(`주문 ${log.accepted_order_ids.length}건 접수, ${log.rejected.length}건 거절 · ${log.market_view}`, SUMMARY_LIMIT);
    case 'hold':
      return truncate(`관망 · ${log.market_view}`, SUMMARY_LIMIT);
    case 'timeout':
      return '시간 초과로 이번 판단을 건너뜁니다.';
    case 'invalid':
      return truncate(`응답 형식 오류 · ${log.error ?? ''}`, SUMMARY_LIMIT);
    case 'error':
      return truncate(`오류 · ${log.error ?? ''}`, SUMMARY_LIMIT);
  }
}

/** The AI participant of `agentId` in `leagueId`, if any (for forced runs). */
export function findAgentParticipant(agentId: number, leagueId: number): number | null {
  const id = sql('SELECT id FROM participants WHERE league_id = ? AND agent_id = ?').pluck().get(leagueId, agentId) as
    | number
    | undefined;
  return id ?? null;
}

interface DueRow {
  participant_id: number;
  market: LeagueRow['market'];
}

let running = false;

/**
 * One decision for every enabled AI participant of an active league whose market is
 * open (ALL: either market) and whose last decision is older than the league's interval. Runs one decision
 * at a time, skips if a previous run is still going, and never throws.
 */
export async function runDueAgents(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const at = now();
    const rows = sql(
      `SELECT p.id AS participant_id, l.market
       FROM participants p
       JOIN leagues l ON l.id = p.league_id
       JOIN agents a ON a.id = p.agent_id
       WHERE l.status = 'active' AND a.enabled = 1 AND l.start_at <= ? AND l.end_at > ?
         AND (p.last_decision_at IS NULL OR p.last_decision_at + l.decision_interval_min * 60000 <= ?)
       ORDER BY COALESCE(p.last_decision_at, 0), p.id`,
    ).all(at, at, at) as DueRow[];

    for (const row of rows) {
      if (!isLeagueOpen(row.market, now()) || inFlight.has(row.participant_id)) continue;
      try {
        await runDecision(row.participant_id);
      } catch (err) {
        console.error(`[agents] decision for participant ${row.participant_id} failed:`, err);
      }
    }
  } catch (err) {
    console.error('[agents] runDueAgents failed:', err);
  } finally {
    running = false;
  }
}

// ---- agent info ----

function toAgentInfo(row: AgentRow): AgentInfo {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    description: row.description,
    enabled: row.enabled === 1,
    disabled_reason: row.enabled === 1 ? null : row.disabled_reason,
    markets: agentMarkets(row),
  };
}

export function listAgents(): AgentInfo[] {
  return (sql('SELECT * FROM agents ORDER BY id').all() as AgentRow[]).map(toAgentInfo);
}

// Leagues visible to @viewer: public, owned, or joined (same rule as canViewLeague); all when null.
const VISIBLE_TO = `(@viewer IS NULL OR l.is_public = 1 OR l.owner_id = @viewer
  OR EXISTS (SELECT 1 FROM participants v WHERE v.league_id = l.id AND v.user_id = @viewer AND v.left_at IS NULL))`;

/**
 * null when the agent does not exist. With `visibleTo`, participations and decisions are
 * limited to leagues that user can see; without it (admins, internal use) nothing is hidden.
 */
export function getAgentDetail(agentId: number, visibleTo?: number): AgentDetail | null {
  const agent = sql('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow | undefined;
  if (!agent) return null;
  const viewer = visibleTo ?? null;

  const rows = sql(
    `SELECT p.id AS participant_id, p.final_rank, p.final_return, l.id AS league_id, l.name AS league_name, l.status
     FROM participants p JOIN leagues l ON l.id = p.league_id
     WHERE p.agent_id = @agentId AND ${VISIBLE_TO}
     ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'recruiting' THEN 1 ELSE 2 END, l.end_at DESC, p.id DESC
     LIMIT @limit`,
  ).all({ viewer, agentId, limit: PARTICIPATIONS_LIMIT }) as {
    participant_id: number;
    final_rank: number | null;
    final_return: number | null;
    league_id: number;
    league_name: string;
    status: LeagueRow['status'];
  }[];

  const participations = rows.map((r) => {
    if (r.status === 'finished' && r.final_return !== null) {
      return { league_id: r.league_id, league_name: r.league_name, participant_id: r.participant_id, return_rate: r.final_return, rank: r.final_rank };
    }
    const row = computeRankings(r.league_id).find((x) => x.participant_id === r.participant_id);
    return {
      league_id: r.league_id,
      league_name: r.league_name,
      participant_id: r.participant_id,
      return_rate: row?.return_rate ?? 0,
      rank: row?.rank ?? null,
    };
  });

  const recent = (
    sql(
      `SELECT d.* FROM decision_logs d JOIN leagues l ON l.id = d.league_id
       WHERE d.agent_id = @agentId AND ${VISIBLE_TO}
       ORDER BY d.ts DESC, d.id DESC LIMIT @limit`,
    ).all({ viewer, agentId, limit: RECENT_DECISIONS }) as DecisionLogRow[]
  ).map(toDecisionLog);

  return { agent: toAgentInfo(agent), participations, recent_decisions: recent };
}
