import type Database from 'better-sqlite3';
import type {
  AgentProvider,
  Currency,
  LeagueMarket,
  LeagueStatus,
  LeagueType,
  Market,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
} from '../../../shared/api-types';
import { db } from '../db/db';

// Row shapes and lookups shared by the engine modules. Statements are prepared lazily so
// importing the engine never touches the database before migrate() has run.

const statements = new Map<string, Database.Statement>();

export function sql(text: string): Database.Statement {
  let s = statements.get(text);
  if (!s) {
    s = db.prepare(text);
    statements.set(text, s);
  }
  return s;
}

export interface LeagueRow {
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
  fee_rate: number;
  tax_rate: number;
  /** Legacy column; the per-symbol position cap is no longer enforced. */
  max_position_pct: number;
  /** FX conversion cost per side (ALL leagues; 0 otherwise). */
  fx_spread: number;
  is_public: number;
  invite_code: string | null;
  owner_id: number | null;
  created_at: number;
}

export interface ParticipantRow {
  id: number;
  league_id: number;
  user_id: number | null;
  agent_id: number | null;
  cash: number;
  joined_at: number;
  last_decision_at: number | null;
  final_rank: number | null;
  final_return: number | null;
  /** When the user forfeited the (active) league; null while participating. */
  left_at: number | null;
}

export interface HoldingRow {
  participant_id: number;
  symbol: string;
  quantity: number;
  /** Native currency. */
  avg_price: number;
  /** Applied FX of the cost basis, USD-amount weighted; 1 unless a US symbol in an ALL league. */
  avg_fx: number;
}

export interface OrderRow {
  id: number;
  participant_id: number;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limit_price: number | null;
  ref_price: number;
  /** FX at placement for US orders in ALL leagues (BUY: spread-applied, what the reservation uses; SELL: mid). */
  ref_fx: number | null;
  status: OrderStatus;
  reject_reason: string | null;
  fill_price: number | null;
  fee: number | null;
  tax: number | null;
  /** Applied FX at fill (US orders in ALL leagues). */
  fx_rate: number | null;
  source: 'user' | 'agent';
  trade_date: string;
  created_at: number;
  filled_at: number | null;
}

export interface AgentRow {
  id: number;
  name: string;
  provider: AgentProvider;
  model: string;
  description: string;
  strategy_prompt: string;
  markets: string;
  enabled: number;
  disabled_reason: string | null;
}

export function getLeagueRow(id: number): LeagueRow | undefined {
  return sql('SELECT * FROM leagues WHERE id = ?').get(id) as LeagueRow | undefined;
}

export function getParticipantRow(id: number): ParticipantRow | undefined {
  return sql('SELECT * FROM participants WHERE id = ?').get(id) as ParticipantRow | undefined;
}

export function getOrderRow(id: number): OrderRow | undefined {
  return sql('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
}

export function getHoldings(participantId: number): HoldingRow[] {
  return sql('SELECT * FROM holdings WHERE participant_id = ? ORDER BY symbol').all(participantId) as HoldingRow[];
}

export function getHolding(participantId: number, symbol: string): HoldingRow | undefined {
  return sql('SELECT * FROM holdings WHERE participant_id = ? AND symbol = ?').get(participantId, symbol) as
    | HoldingRow
    | undefined;
}

export interface SnapshotRow {
  participant_id: number;
  ts: number;
  equity: number;
  return_rate: number;
  /** USD/KRW mid the equity used (ALL leagues; null otherwise, before any rate, or for snapshots older than the column). */
  fx_rate: number | null;
}

export function lastSnapshot(participantId: number): SnapshotRow | undefined {
  return sql('SELECT * FROM snapshots WHERE participant_id = ? ORDER BY ts DESC LIMIT 1').get(participantId) as
    | SnapshotRow
    | undefined;
}

export function getParticipantsOf(leagueId: number): ParticipantRow[] {
  return sql('SELECT * FROM participants WHERE league_id = ? ORDER BY id').all(leagueId) as ParticipantRow[];
}

export function agentMarkets(agent: Pick<AgentRow, 'markets'>): Market[] {
  return agent.markets
    .split(',')
    .map((m) => m.trim())
    .filter((m): m is Market => m === 'KR' || m === 'US');
}

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    participant_id: row.participant_id,
    symbol: row.symbol,
    side: row.side,
    type: row.type,
    quantity: row.quantity,
    limit_price: row.limit_price,
    status: row.status,
    reject_reason: row.reject_reason,
    fill_price: row.fill_price,
    fee: row.fee,
    tax: row.tax,
    fx_rate: row.fx_rate ?? null,
    created_at: row.created_at,
    filled_at: row.filled_at,
    source: row.source,
  };
}

/** Per-share price a pending BUY reserves cash at: its limit, or the quote at placement. */
export function reservePrice(order: Pick<OrderRow, 'type' | 'limit_price' | 'ref_price'>): number {
  return order.type === 'LIMIT' && order.limit_price !== null ? order.limit_price : order.ref_price;
}
