import type { FxQuote, Quote } from '../../../../shared/api-types';
import type { SymbolInfo } from '../symbols';

export interface DailyBar {
  /** YYYY-MM-DD in the market's local time zone. */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface PriceProvider {
  name: 'yahoo' | 'kis' | 'sim';
  /**
   * Fetches the latest quote for each symbol. Per-symbol failures are logged and omitted,
   * so the result may be shorter than the input; it rejects only on programming errors.
   */
  fetchQuotes(symbols: SymbolInfo[]): Promise<Quote[]>;
  /** Up to `days` most recent daily bars, oldest first. */
  fetchDailyBars(symbol: SymbolInfo, days: number): Promise<DailyBar[]>;
  /**
   * Optional batched form of fetchDailyBars, keyed by `SymbolInfo.symbol`. Symbols it could
   * not load are simply missing from the map; the collector fetches those one by one.
   */
  fetchDailyBarsMany?(symbols: SymbolInfo[], days: number): Promise<Map<string, DailyBar[]>>;
  /** Latest USD/KRW mid rate (Yahoo `KRW=X`); rejects on failure. */
  fetchFx?(): Promise<FxTick>;
}

/** A USD/KRW rate as a provider returns it (`stale` is derived when read, see market/fx.ts). */
export type FxTick = Omit<FxQuote, 'stale'>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
