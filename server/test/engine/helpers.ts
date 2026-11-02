import type { AgentProvider, LeagueMarket, PlaceOrderRequest, Quote } from '../../../shared/api-types';
import { config } from '../../src/config';
import { db, resetDb } from '../../src/db/db';
import { createLeague, type CreateLeagueInput } from '../../src/engine/leagues';
import { placeOrder } from '../../src/engine/orders';
import { setNow } from '../../src/lib/time';
import { clearFx, setFx, storeFx } from '../../src/market/fx';
import { clearQuotes, setQuotes } from '../../src/market/quoteCache';
import { getSymbol } from '../../src/market/symbols';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Monday 2026-10-19 09:00 KST, the KR open. No KR/US holidays from here to mid-November. */
export const KR_OPEN = Date.UTC(2026, 9, 19, 0, 0);
/** Monday 2026-10-19 15:30 KST, the KR close. */
export const KR_CLOSE = Date.UTC(2026, 9, 19, 6, 30);
/** Monday 2026-10-19 09:30 EDT, the US open. */
export const US_OPEN = Date.UTC(2026, 9, 19, 13, 30);
export { MIN, HOUR };

let clock = KR_OPEN;

export function setClock(t: number): void {
  clock = t;
}

export function clockNow(): number {
  return clock;
}

export function resetEngineState(t: number = KR_OPEN + HOUR): void {
  resetDb();
  clearQuotes();
  clearFx();
  config.simAlwaysOpen = false;
  clock = t;
  setNow(() => clock);
}

export function restoreEngineState(): void {
  setNow(null);
  clearQuotes();
  clearFx();
  config.simAlwaysOpen = false;
}

export function quote(symbol: string, price: number, ts: number = clock): Quote {
  const info = getSymbol(symbol);
  if (!info) throw new Error(`unknown symbol ${symbol}`);
  return { symbol, market: info.market, price, change_pct: 0, volume: 1000, ts, source: 'sim' };
}

/** Sets the current USD/KRW mid (and stores it in fx_rates) as of `ts`. */
export function setFxRate(rate: number, ts: number = clock): void {
  const fx = { pair: 'USDKRW' as const, rate, change_pct: 0, ts, source: 'sim' as const };
  setFx(fx);
  storeFx(fx);
}

/** Puts quotes into the cache and returns them, ready for matchOrders(). */
export function feed(...quotes: Quote[]): Quote[] {
  setQuotes(quotes);
  return quotes;
}

let userSeq = 0;
export function makeUser(nickname = `user${++userSeq}`): number {
  return Number(
    db
      .prepare("INSERT INTO users (email, password_hash, nickname, created_at) VALUES (?, 'x', ?, 0)")
      .run(`${nickname}-${++userSeq}@test.dev`, nickname).lastInsertRowid,
  );
}

export function makeAgent(
  name: string,
  opts: { provider?: AgentProvider; model?: string; markets?: string; enabled?: boolean } = {},
): number {
  return Number(
    db
      .prepare('INSERT INTO agents (name, provider, model, markets, enabled) VALUES (?, ?, ?, ?, ?)')
      .run(name, opts.provider ?? 'rule', opts.model ?? 'baseline', opts.markets ?? 'KR,US', opts.enabled === false ? 0 : 1)
      .lastInsertRowid,
  );
}

/** Creates an active custom league owned by a fresh user; returns ids. */
export function activeLeague(
  market: LeagueMarket = 'KR',
  overrides: Partial<CreateLeagueInput> = {},
): { leagueId: number; ownerId: number; participantId: number } {
  const ownerId = overrides.owner_id ?? makeUser('owner');
  const summary = createLeague({
    name: '테스트 리그',
    market,
    type: 'custom',
    duration_days: 5,
    is_public: true,
    start_at: market === 'US' ? US_OPEN : KR_OPEN,
    ...overrides,
    owner_id: ownerId,
  });
  return { leagueId: summary.id, ownerId, participantId: summary.my_participant_id! };
}

export function cashOf(participantId: number): number {
  return db.prepare('SELECT cash FROM participants WHERE id = ?').pluck().get(participantId) as number;
}

export function buy(participantId: number, symbol: string, quantity: number, limit?: number) {
  const req: PlaceOrderRequest =
    limit === undefined
      ? { symbol, side: 'BUY', type: 'MARKET', quantity }
      : { symbol, side: 'BUY', type: 'LIMIT', quantity, limit_price: limit };
  return placeOrder(participantId, req, 'user');
}

export function sell(participantId: number, symbol: string, quantity: number, limit?: number) {
  const req: PlaceOrderRequest =
    limit === undefined
      ? { symbol, side: 'SELL', type: 'MARKET', quantity }
      : { symbol, side: 'SELL', type: 'LIMIT', quantity, limit_price: limit };
  return placeOrder(participantId, req, 'user');
}
