import type { FxQuote, OrderSide } from '../../../shared/api-types';
import { db } from '../db/db';
import { now } from '../lib/time';
import type { FxTick } from './providers/types';

// USD/KRW for 통합 (ALL) leagues: one in-memory current rate (newest wins), persisted in fx_rates
// (one row per source timestamp, never overwritten). Snapshots of ALL leagues record the rate they
// used (snapshots.fx_rate), so finished leagues are valued at exactly that rate.

export const FX_PAIR = 'USDKRW' as const;
/** A rate older than this is stale: US fills in ALL leagues wait for a fresh one (valuation keeps using it). */
export const FX_STALE_MS = 30 * 60_000;
/** FX conversion cost per side in ALL leagues (0.1%), stored per league as `fx_spread`. */
export const DEFAULT_FX_SPREAD = 0.001;

let current: FxTick | undefined;

export function isFxStale(fx: Pick<FxTick, 'ts'>, at: number = now()): boolean {
  return at - fx.ts > FX_STALE_MS;
}

/** The current USD/KRW rate with `stale` evaluated now, or null before the first fetch. */
export function getFx(at: number = now()): FxQuote | null {
  return current ? { ...current, stale: isFxStale(current, at) } : null;
}

/** Replaces the current rate unless it is newer than `fx` (an older fetch never wins). */
export function setFx(fx: FxTick): void {
  if (!current || fx.ts >= current.ts) current = { ...fx, pair: FX_PAIR };
}

/** Tests only. */
export function clearFx(): void {
  current = undefined;
}

/**
 * One fx_rates row per source timestamp (exact ts, not floored). A row is never replaced: a
 * repeated fetch of the same tick is ignored, so a rate a snapshot or fxAt() has used stays put.
 */
export function storeFx(fx: FxTick): void {
  db.prepare('INSERT OR IGNORE INTO fx_rates (pair, ts, rate, source) VALUES (?, ?, ?, ?)').run(
    FX_PAIR,
    fx.ts,
    fx.rate,
    fx.source,
  );
}

/**
 * Boot: seeds the in-memory rate from the latest fx_rates row with its stored ts (so it is
 * stale until a fresh fetch, and US fills keep waiting), letting valuation and US order
 * placement work right after a restart. No-op when nothing is stored; never replaces a newer rate.
 */
export function loadStoredFx(): void {
  const row = db.prepare('SELECT rate, ts, source FROM fx_rates WHERE pair = ? ORDER BY ts DESC LIMIT 1').get(FX_PAIR) as
    | { rate: number; ts: number; source: FxTick['source'] }
    | undefined;
  if (row) setFx({ pair: FX_PAIR, rate: row.rate, change_pct: 0, ts: row.ts, source: row.source });
}

/** Last stored rate at or before `ts`. */
export function fxAt(ts: number): number | undefined {
  return db.prepare('SELECT rate FROM fx_rates WHERE pair = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').pluck().get(FX_PAIR, ts) as
    | number
    | undefined;
}

/** Latest stored row (sim provider start rate). */
export function latestStoredFx(): { rate: number; ts: number } | undefined {
  return db.prepare('SELECT rate, ts FROM fx_rates WHERE pair = ? ORDER BY ts DESC LIMIT 1').get(FX_PAIR) as
    | { rate: number; ts: number }
    | undefined;
}

/** Rate a trade converts at: mid × (1 + spread) when buying USD (BUY), × (1 − spread) when selling. */
export function appliedFx(mid: number, side: OrderSide, spread: number): number {
  const rate = mid * (side === 'BUY' ? 1 + spread : 1 - spread);
  return Math.round(rate * 10_000) / 10_000;
}
