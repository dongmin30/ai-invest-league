import type { FxQuote, InstrumentKind, LeagueSummary, Market, Order, Portfolio } from '../../../shared/api-types';
import type { AgentRow } from '../engine/store';
import type { Decision } from './schema';

export type { AgentRow } from '../engine/store';
export type { Decision } from './schema';

/** One symbol shown to an agent (see `selectCandidates` for which symbols make the list). */
export interface CandidateRow {
  symbol: string;
  name: string;
  /** Symbol market; `price` is in its currency (KR: KRW, US: USD). */
  market: Market;
  /** Whether the symbol's market is open now (orders for a closed market wait for its next open). */
  market_open: boolean;
  kind: InstrumentKind;
  /** Daily return multiple: 1 for stocks and plain ETFs, 2/3 leveraged, negative inverse. */
  leverage: number;
  /** Index or stock a leveraged/inverse ETF multiplies, when it is in the pool. */
  underlying?: string;
  /** null when no quote has been collected yet. */
  price: number | null;
  change_pct: number | null;
  volume: number | null;
  /** Last daily closes, oldest first (may be shorter than 5). */
  closes_5d: number[];
  /** ALL (통합) leagues only: price in KRW at the USD/KRW mid (= price for KR symbols; null without a price or rate). */
  price_krw?: number | null;
}

/** League parameters that LeagueSummary does not carry but the rules depend on. */
export interface LeagueRules {
  /** League columns; in ALL leagues trades use `rates` of the symbol's market instead. */
  fee_rate: number;
  tax_rate: number;
  /** FX conversion cost per side for US symbols in ALL leagues (0 otherwise). */
  fx_spread: number;
  /** Fee and stock SELL tax per symbol market the league trades (KR ETFs pay no tax). */
  rates: Partial<Record<Market, { fee_rate: number; tax_rate: number }>>;
}

export interface DecisionInput {
  agent: AgentRow;
  league: LeagueSummary;
  rules: LeagueRules;
  portfolio: Portfolio;
  /** The participant's pending orders (cash and shares they hold back). */
  pendingOrders: Order[];
  candidates: CandidateRow[];
  /** The league can trade now (ALL: either market is open). */
  marketOpen: boolean;
  /** Open state per market the league trades. */
  marketsOpen: Partial<Record<Market, boolean>>;
  /** USD/KRW for ALL leagues, null otherwise. */
  fx: FxQuote | null;
  now: number;
}

export interface ProviderResult {
  decision: Decision;
  raw: string;
  input_tokens?: number;
  output_tokens?: number;
}

export interface LLMProvider {
  decide(input: DecisionInput, signal: AbortSignal): Promise<ProviderResult>;
}

export type AgentErrorKind = 'invalid' | 'error';

/** Provider failure: `invalid` for unusable output, `error` for transport/API problems. */
export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly raw: string | undefined;

  constructor(kind: AgentErrorKind, message: string, raw?: string) {
    super(message);
    this.name = 'AgentError';
    this.kind = kind;
    this.raw = raw;
  }
}
