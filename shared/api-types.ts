// API contract shared by server and web. Server responses MUST match these shapes.
// All timestamps are epoch milliseconds (number). Money is a plain number in the league currency.
// In an 'ALL' (통합) league the currency is KRW: native prices (fill_price, avg_price, limit_price) stay
// in the symbol's own currency, while cash, fees, taxes, values and P&L are KRW.

export type Market = 'KR' | 'US';
/** Market of a league: a single symbol market, or 'ALL' (통합 리그: KR + US in one KRW account, FX at fill). */
export type LeagueMarket = Market | 'ALL';
export type Currency = 'KRW' | 'USD';
export type LeagueType = '3d' | '1w' | '1m' | 'custom';
export type OfficialLeagueType = Exclude<LeagueType, 'custom'>;

/** GET/PUT /api/admin/official-series: one auto-run official league series (market × length). */
export interface OfficialSeries {
  market: LeagueMarket;
  type: OfficialLeagueType;
  /** Off by default; while off no league of this series is scheduled or kept running. */
  enabled: boolean;
  active_count: number;
  recruiting_count: number;
}
export type LeagueStatus = 'recruiting' | 'active' | 'finished';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'pending' | 'filled' | 'canceled' | 'rejected';
export type ParticipantKind = 'human' | 'ai';
export type AgentProvider = 'claude' | 'ollama' | 'rule';
export type InstrumentKind = 'stock' | 'etf';

export interface ApiError {
  error: string; // machine code, e.g. 'insufficient_cash'
  message: string; // Korean, user-facing
}

export interface User {
  id: number;
  email: string;
  nickname: string;
  role: 'user' | 'admin';
  created_at: number;
}

/** GET /api/auth/signup-options (public). */
export interface SignupOptions {
  signup_code_required: boolean;
}

export interface Quote {
  symbol: string; // provider-neutral code: '005930' (KR) or 'AAPL' (US)
  market: Market;
  price: number;
  change_pct: number; // vs previous close, percent (2.5 = +2.5%)
  volume: number;
  ts: number; // time of the price at the source
  source: 'yahoo' | 'kis' | 'sim';
}

export interface SymbolRow {
  symbol: string;
  name: string;
  market: Market;
  exchange: 'KOSPI' | 'KOSDAQ' | 'NASDAQ' | 'NYSE' | 'NYSE Arca' | 'Cboe BZX';
  kind: InstrumentKind;
  leverage: number; // daily return multiple: 1 (stocks, plain ETFs), 2/3 leveraged, -1/-2/-3 inverse
  underlying: string | null; // index/stock a leveraged or inverse ETF multiplies, when it is in the pool
  category: string; // short Korean label, e.g. '반도체', '레버리지', '해외 지수'
  price: number | null;
  change_pct: number | null;
  ts: number | null;
  stale: boolean; // true when the last quote is older than 5 minutes while the market is open
}

/** USD/KRW mid rate (KRW per 1 USD) used by 통합 leagues. */
export interface FxQuote {
  pair: 'USDKRW';
  rate: number;
  change_pct: number; // vs previous close, percent
  ts: number; // time of the rate at the source
  source: 'yahoo' | 'sim';
  stale: boolean; // older than 30 minutes: US fills in 통합 leagues wait (valuation keeps using it)
}

export interface MarketStatus {
  market: Market;
  open: boolean;
  next_open: number | null;
  next_close: number | null;
  provider: 'yahoo' | 'kis' | 'sim';
  note: string; // Korean note shown in UI, e.g. '시세 출처: Yahoo Finance (지연될 수 있음)'
}

export interface LeagueSummary {
  id: number;
  name: string;
  type: LeagueType;
  market: LeagueMarket;
  currency: Currency;
  status: LeagueStatus;
  start_at: number;
  end_at: number;
  start_cash: number;
  decision_interval_min: number;
  max_orders_per_day: number;
  fx_spread: number; // FX conversion cost per side (fraction, 0.001 = 0.1%); 0 for single-market leagues
  participant_count: number;
  ai_count: number;
  is_public: boolean;
  joined: boolean; // whether the current user has a participant in it (forfeited ones excluded)
  my_participant_id: number | null;
  left: boolean; // the current user forfeited (left) this league while it was active; cannot rejoin
}

export interface RankingRow {
  participant_id: number;
  rank: number | null; // null when not eligible (no filled trade yet)
  display_name: string;
  kind: ParticipantKind;
  agent_id: number | null;
  provider: AgentProvider | null;
  model: string | null;
  equity: number;
  return_rate: number; // fraction: 0.031 = +3.1%
  mdd: number; // fraction, <= 0: -0.08 = -8%
  trade_count: number; // filled orders
  eligible: boolean;
}

export interface LeagueDetail {
  league: LeagueSummary;
  rankings: RankingRow[];
  human_avg_return: number | null;
  ai_avg_return: number | null; // LLM agents only (provider !== 'rule')
  baseline_return: number | null; // the rule:baseline agent if present
}

export interface EquityPoint {
  ts: number;
  return_rate: number;
}

export interface EquitySeries {
  participant_id: number;
  display_name: string;
  kind: ParticipantKind;
  points: EquityPoint[];
}

export interface DashboardCard {
  league: LeagueSummary;
  my_rank: number | null;
  my_return_rate: number;
  participant_count: number;
  remaining_ms: number; // until end_at (or until start_at when recruiting)
  best_ai_name: string | null;
  best_ai_return: number | null;
  human_avg_return: number | null;
  ai_avg_return: number | null;
}

export interface Holding {
  symbol: string;
  name: string;
  currency: Currency; // native currency of price / avg_price
  quantity: number;
  avg_price: number; // native
  price: number; // native
  fx_rate: number; // rate converting price into the league currency for `value` (1 unless a US symbol in a 통합 league)
  value: number; // league currency
  pnl: number; // league currency, includes the FX effect
  pnl_rate: number; // fraction
}

export interface Portfolio {
  participant_id: number;
  league_id: number;
  currency: Currency;
  cash: number;
  available_cash: number; // cash minus reservations for pending BUY orders
  equity: number;
  return_rate: number;
  holdings: Holding[];
  orders_today: number;
  max_orders_per_day: number;
  fx: FxQuote | null; // live USD/KRW for 통합 leagues, null otherwise
}

export interface Order {
  id: number;
  participant_id: number;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limit_price: number | null;
  status: OrderStatus;
  reject_reason: string | null;
  fill_price: number | null; // native currency of the symbol
  fee: number | null; // league currency
  tax: number | null; // league currency
  fx_rate: number | null; // applied USD/KRW (spread included) for US fills in 통합 leagues, else null
  created_at: number;
  filled_at: number | null;
  source: 'user' | 'agent';
}

export interface PlaceOrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limit_price?: number; // native currency of the symbol (USD for US symbols, also in 통합 leagues)
}

export interface CreateLeagueRequest {
  name: string;
  market: LeagueMarket;
  duration_days: number; // trading days, 1..20 (통합: unified days, KR session + following US session)
  start_cash?: number; // defaults: KR 10_000_000, US 10_000, ALL 10_000_000 (KRW)
  agent_ids: number[];
  is_public: boolean;
  start_now: boolean; // true: starts immediately (custom/demo leagues)
}

/** POST /leagues/:id/leave. `forfeited`: the league was active (participant kept, marked left); false: recruiting (participant removed). */
export interface LeaveLeagueResponse {
  ok: true;
  forfeited: boolean;
}

export interface AgentInfo {
  id: number;
  name: string;
  provider: AgentProvider;
  model: string;
  description: string;
  enabled: boolean;
  disabled_reason: string | null; // e.g. 'ANTHROPIC_API_KEY 미설정'
  markets: Market[];
}

export interface DecisionOrder {
  symbol: string;
  side: OrderSide;
  quantity: number;
  reason: string;
}

export interface DecisionLog {
  id: number;
  agent_id: number;
  participant_id: number;
  league_id: number;
  ts: number;
  market_view: string;
  orders: DecisionOrder[]; // as proposed by the model (after schema validation)
  accepted_order_ids: number[];
  rejected: { symbol: string; reason: string }[];
  status: 'ok' | 'hold' | 'invalid' | 'error' | 'timeout';
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
}

export interface AgentDetail {
  agent: AgentInfo;
  participations: { league_id: number; league_name: string; participant_id: number; return_rate: number; rank: number | null }[];
  recent_decisions: DecisionLog[];
}

// Server-Sent Events on GET /api/stream?league_id=<id>
export type StreamEvent =
  | { type: 'quotes'; quotes: Quote[] }
  | { type: 'rankings'; league_id: number; rankings: RankingRow[] }
  | { type: 'decision'; league_id: number; agent_id: number; agent_name: string; status: DecisionLog['status']; summary: string }
  | { type: 'order'; league_id: number; participant_id: number; order: Order }
  | { type: 'fx'; fx: FxQuote }; // 통합 league streams only
