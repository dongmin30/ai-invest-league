import type { Statement } from 'better-sqlite3';
import type { Market, Quote } from '../../../../shared/api-types';
import { db } from '../../db/db';
import { now } from '../../lib/time';
import { isTradingDay, marketDate } from '../calendar';
import { latestStoredFx } from '../fx';
import { getSymbol, SYMBOLS, type SymbolInfo } from '../symbols';
import { errorMessage } from './http';
import type { DailyBar, FxTick, PriceProvider } from './types';

// Offline random-walk prices. Each symbol has its own PRNG seeded from its code, so a fresh
// provider replays the same path from the same starting price. Start price: latest `quotes`
// row, else latest `daily_bars` close, else a real latest quote fetched once at startup
// (`seed`, best effort), else BASE_PRICES (Yahoo closes of 2026-10-30).
// A leveraged/inverse ETF with an `underlying` does not walk on its own: each tick its
// return is `leverage` × the underlying's return since the ETF's previous tick, so SQQQ
// moves -3× QQQ. Other leveraged products (no underlying) walk |leverage|× wider.

const TICK_MOVE = 0.003;
const DAILY_MOVE = 0.02;
/** USD/KRW walk: ±0.02% per tick from the latest fx_rates row, else a real seed, else SIM_FX_BASE. */
const FX_TICK_MOVE = 0.0002;
/** Yahoo KRW=X on 2026-10-31. */
export const SIM_FX_BASE = 1335.1;

const BASE_PRICES: Record<string, number> = {
  '005930': 225000, '000660': 1418000, '373220': 359500, '207940': 1487000, '005380': 282000, '000270': 95600,
  '068270': 191600, '005490': 273500, '035420': 172300, '035720': 29450, '051910': 235000, '006400': 543000,
  '105560': 155500, '055550': 89600, '086790': 120500, '012330': 334000, '028260': 312000, '066570': 150700,
  '003550': 96200, '032830': 270500, '015760': 28600, '017670': 75400, '034020': 54800, '012450': 696000,
  '329180': 274000, '009540': 231500, '247540': 90900, '086520': 72200, '196170': 211500, '028300': 40000,
  '000810': 659000, '010130': 876000, '011200': 23350, '096770': 129900, '034730': 503000, '018260': 203000,
  '033780': 196200, '030200': 46300, '010950': 123000, '009150': 1196000, '000100': 75100, '138040': 133200,
  '316140': 30800, '024110': 19380, '323410': 19920, '259960': 182100, '352820': 157000, '036570': 201500,
  '090430': 129100, '097950': 173200, '004020': 25850, '010140': 15880, '042660': 50000, '267250': 140800,
  '064350': 76500, '047810': 97800, '003670': 162100, '006800': 25500, '071050': 152200, '000720': 83600,
  '086280': 183800, '011070': 326000, '402340': 897000, '042700': 182700, '326030': 77700, '035900': 39400,
  '041510': 76400, '058470': 56100, '039030': 388500, '145020': 179800, '277810': 363000, '141080': 61500,
  '214450': 212000, '263750': 35000, '069500': 90800, '102110': 90640, '278530': 32960, '229200': 11910,
  '292150': 30940, '122630': 72545, '123320': 73180, '233740': 4785, '114800': 1177, '123310': 1313,
  '252670': 97, '252710': 107, '251340': 2755, '360750': 25310, '379800': 22945, '133690': 170475,
  '379810': 25465, '381170': 29045, '381180': 38285, '458730': 15175, '091160': 106755, '396500': 30440,
  '091170': 14360, '305720': 13430, '305540': 17040, '139260': 114460, '132030': 22295, '144600': 8230,
  '261220': 30325, '114260': 62525, '261240': 13845, AAPL: 344.63, MSFT: 521.91, NVDA: 204.64,
  AMZN: 240.35, GOOGL: 279.84, META: 614.99, TSLA: 399.81, AVGO: 326.08, COST: 1012.28,
  NFLX: 62.08, AMD: 504.8, ADBE: 250.23, PEP: 137.34, CSCO: 104.51, QCOM: 164.79,
  WMT: 123.51, JPM: 337.04, V: 413.59, MA: 638.01, JNJ: 273.2, PG: 161.57,
  XOM: 187.25, UNH: 406.97, HD: 329.2, KO: 94.08, BAC: 50.01, CVX: 235.52,
  LLY: 1417.54, ORCL: 130.67, DIS: 110.94, INTC: 65.76, TXN: 300.84, AMAT: 390.09,
  LRCX: 239.11, KLAC: 157.91, MU: 884.74, ADI: 417.11, MRVL: 196.4, ARM: 205.97,
  TSM: 406.13, ASML: 1565.9, PANW: 365.87, CRWD: 250.43, INTU: 341.09, CRM: 229.17,
  NOW: 105.12, PLTR: 184.11, SNPS: 467.61, CDNS: 327.89, IBM: 257.81, ACN: 258.24,
  ANET: 168.86, APP: 228.5, SHOP: 157.49, UBER: 65.25, ABNB: 164.39, BKNG: 148.13,
  MELI: 1624.53, PDD: 78.61, BABA: 98.04, PYPL: 57.01, COIN: 143.54, MSTR: 130.51,
  TMUS: 156.44, CMCSA: 23.22, T: 21.41, VZ: 44.73, WFC: 83.4, GS: 894.55,
  MS: 184.3, C: 122.64, AXP: 319.11, BLK: 1147.54, SCHW: 88.05, SPGI: 466.55,
  MRK: 149.52, ABBV: 294.89, PFE: 30.52, TMO: 697, ABT: 106.2, AMGN: 466.01,
  ISRG: 432.01, GILD: 170.68, VRTX: 558.88, MCD: 258.12, NKE: 38.67, SBUX: 103.67,
  LOW: 209.07, TGT: 154.38, PM: 208.79, MDLZ: 64.94, CAT: 622.75, DE: 675.48,
  GE: 301.8, BA: 171.55, RTX: 199.8, LMT: 636.95, HON: 218.33, UNP: 304,
  UPS: 108.25, LIN: 514.24, NEE: 83.71, COP: 154.03, SPY: 755.72, VOO: 694.81,
  VTI: 371.57, QQQ: 690.49, DIA: 517.13, IWM: 279.33, RSP: 218.31, XLK: 179.51,
  XLF: 56.51, XLE: 70.02, XLV: 184.87, XLY: 115.38, XLP: 89.42, XLI: 167.4,
  XLU: 43.43, SMH: 522.49, SOXX: 471.51, ARKK: 80.75, XBI: 155.98, KRE: 72.01,
  SCHD: 35.78, EEM: 61.04, EFA: 103.37, EWY: 152.89, TLT: 81.84, IEF: 91.76,
  SHY: 81.7, HYG: 77.43, GLD: 355.78, SLV: 44.6, USO: 168.83, TQQQ: 62.01,
  QLD: 82.59, UPRO: 141.21, SPXL: 270.35, SSO: 67.67, UDOW: 65.45, SOXL: 77.05,
  TECL: 173.11, TNA: 57.77, LABU: 247.22, FAS: 164.8, TMF: 29.85, NVDL: 28.97,
  TSLL: 11.17, SQQQ: 41.83, QID: 15.09, PSQ: 26.63, SPXU: 36, SPXS: 25.63,
  SDS: 55.89, SH: 32.86, DOG: 22.01, SDOW: 25, SOXS: 52.08, TZA: 46.75,
  LABD: 6.98, FAZ: 33.49, TSLQ: 14.78, UVXY: 19.33,
};

const DEFAULT_BASE: Record<Market, number> = { KR: 50_000, US: 100 };

/** FNV-1a 32-bit hash. */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic PRNG returning floats in [0, 1). */
export function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** KRX tick size for a price level; US prices use cents. */
export function tickSize(market: Market, price: number): number {
  if (market === 'US') return 0.01;
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

export function roundToTick(market: Market, price: number): number {
  if (market === 'US') return Math.max(0.01, Math.round(price * 100) / 100);
  const tick = tickSize(market, price);
  return Math.max(tick, Math.round(price / tick) * tick);
}

// Statements are prepared on first use: this module is imported before migrate() runs.
const sql = {
  latestQuote: 'SELECT price FROM quotes WHERE symbol = ? ORDER BY ts DESC LIMIT 1',
  latestClose: 'SELECT close FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT 1',
  prevClose: 'SELECT close FROM daily_bars WHERE symbol = ? AND date < ? ORDER BY date DESC LIMIT 1',
  bars: 'SELECT date, open, high, low, close, volume FROM daily_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?',
};
const prepared = new Map<string, Statement>();
const stmt = (key: keyof typeof sql): Statement => {
  let s = prepared.get(key);
  if (!s) prepared.set(key, (s = db.prepare(sql[key])));
  return s;
};
const scalar = (key: keyof typeof sql, ...params: unknown[]) =>
  stmt(key).pluck().get(...params) as number | undefined;

function storedPrice(info: SymbolInfo): number | undefined {
  const fromQuote = scalar('latestQuote', info.symbol);
  if (fromQuote && fromQuote > 0) return fromQuote;
  const fromBar = scalar('latestClose', info.symbol);
  if (fromBar && fromBar > 0) return fromBar;
  return undefined;
}

/** Latest stored quote, else latest daily close, else a seeded real quote, else BASE_PRICES. */
export function startPrice(info: SymbolInfo, seeded?: ReadonlyMap<string, Quote>): number {
  const seed = seeded?.get(info.symbol)?.price;
  return storedPrice(info) ?? (seed && seed > 0 ? seed : undefined) ?? BASE_PRICES[info.symbol] ?? DEFAULT_BASE[info.market];
}

/** Built-in base price, so tests can check every symbol has one. */
export function basePrice(symbol: string): number | undefined {
  return BASE_PRICES[symbol];
}

interface WalkState {
  rng: () => number;
  /** Unrounded so tick rounding never pins the walk. */
  price: number;
  prevClose: number;
  volume: number;
  day: string;
  /** fetchQuotes call that last stepped this walk (a symbol steps at most once per call). */
  lastCall: number;
  /** Price before that step, so an ETF created later in the same call starts from it. */
  stepFrom: number;
  /** Underlying's unrounded price at this ETF's previous step (ETFs with an underlying only). */
  underlyingRef?: number;
}

export interface SimOptions {
  /**
   * Fetches real latest quotes for symbols without a stored price; called once, before the
   * first walk step or generated bar. Best effort: a failure or `seedTimeoutMs` leaves
   * BASE_PRICES in place.
   */
  seed?: (symbols: SymbolInfo[]) => Promise<Quote[]>;
  /** Real latest USD/KRW, used once when fx_rates is empty. Best effort, same timeout. */
  seedFx?: () => Promise<FxTick>;
  seedTimeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface FxWalk {
  rng: () => number;
  rate: number;
  prevClose: number;
  day: string;
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

export function createSimProvider(opts: SimOptions = {}): PriceProvider {
  const states = new Map<string, WalkState>();
  const seeded = new Map<string, Quote>();
  let seeding: Promise<void> | null = null;
  let call = 0;
  let fxWalk: Promise<FxWalk> | null = null;

  function fxStart(): Promise<FxWalk> {
    fxWalk ??= (async () => {
      let rate = latestStoredFx()?.rate;
      let prevClose: number | undefined;
      if (!(rate && rate > 0) && opts.seedFx) {
        try {
          const seed = await withTimeout(opts.seedFx(), opts.seedTimeoutMs ?? 10_000);
          if (seed.rate > 0) {
            rate = seed.rate;
            prevClose = seed.rate / (1 + seed.change_pct / 100);
          }
        } catch (err) {
          console.warn(`[sim] could not seed USD/KRW (${errorMessage(err)}); using ${SIM_FX_BASE}`);
        }
      }
      const start = rate && rate > 0 ? rate : SIM_FX_BASE;
      return { rng: seededRandom('USDKRW'), rate: start, prevClose: prevClose ?? start, day: marketDate('KR', now()) };
    })();
    return fxWalk;
  }

  function ensureSeeded(): Promise<void> {
    const seed = opts.seed;
    if (!seed) return Promise.resolve();
    seeding ??= (async () => {
      const need = SYMBOLS.filter((info) => storedPrice(info) === undefined);
      if (need.length === 0) return;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), opts.seedTimeoutMs ?? 10_000);
        timer.unref?.();
      });
      try {
        const quotes = await Promise.race([seed(need), timeout]);
        for (const q of quotes) if (q.price > 0) seeded.set(q.symbol, q);
        console.log(`[sim] seeded ${seeded.size}/${need.length} start prices from real quotes`);
      } catch (err) {
        console.warn(`[sim] could not seed start prices (${errorMessage(err)}); using built-in base prices`);
      } finally {
        clearTimeout(timer);
      }
    })();
    return seeding;
  }

  function stateFor(info: SymbolInfo, day: string): WalkState {
    let s = states.get(info.symbol);
    if (!s) {
      const price = startPrice(info, seeded);
      const prev = scalar('prevClose', info.symbol, day);
      const seed = seeded.get(info.symbol);
      const seedPrev = seed && storedPrice(info) === undefined ? seed.price / (1 + seed.change_pct / 100) : undefined;
      s = {
        rng: seededRandom(info.symbol),
        price,
        prevClose: prev && prev > 0 ? prev : seedPrev && seedPrev > 0 ? seedPrev : price,
        volume: 0,
        day,
        lastCall: -1,
        stepFrom: price,
      };
      states.set(info.symbol, s);
      const u = underlyingOf(info);
      if (u) {
        const us = stateFor(u, day);
        s.underlyingRef = us.lastCall === call ? us.stepFrom : us.price;
      }
    } else if (s.day !== day) {
      s.prevClose = roundToTick(info.market, s.price);
      s.volume = 0;
      s.day = day;
    }
    return s;
  }

  function underlyingOf(info: SymbolInfo): SymbolInfo | undefined {
    const u = info.underlying ? getSymbol(info.underlying) : undefined;
    return u && u.market === info.market && !u.underlying ? u : undefined;
  }

  /** Advances one walk for the current call (idempotent within a call). */
  function step(info: SymbolInfo, day: string): WalkState {
    const s = stateFor(info, day);
    if (s.lastCall === call) return s;
    s.lastCall = call;
    s.stepFrom = s.price;
    const u = underlyingOf(info);
    if (u) {
      const us = step(u, day);
      const ret = us.price / s.underlyingRef! - 1;
      s.price *= Math.max(0.01, 1 + info.leverage * ret);
      s.underlyingRef = us.price;
    } else {
      s.price *= 1 + (s.rng() * 2 - 1) * TICK_MOVE * Math.max(1, Math.abs(info.leverage));
    }
    s.volume += Math.round((info.market === 'KR' ? 20_000 : 50_000) * (0.2 + s.rng()));
    return s;
  }

  function generateBars(info: SymbolInfo, days: number): DailyBar[] {
    const rng = seededRandom(`${info.symbol}:bars`);
    const volumeBase = info.market === 'KR' ? 2_000_000 : 20_000_000;
    const move = DAILY_MOVE * Math.max(1, Math.abs(info.leverage));
    let close = startPrice(info, seeded);
    let date = marketDate(info.market, now());
    const bars: DailyBar[] = [];
    // Walk backwards from the start price so the generated history ends where the live walk begins.
    for (let guard = 0; bars.length < days && guard < days * 3 + 30; guard++) {
      date = shiftDate(date, -1);
      if (!isTradingDay(info.market, date)) continue;
      const open = close / (1 + (rng() * 2 - 1) * move);
      const high = Math.max(open, close) * (1 + rng() * 0.01);
      const low = Math.min(open, close) * (1 - rng() * 0.01);
      bars.push({
        date,
        open: roundToTick(info.market, open),
        high: roundToTick(info.market, high),
        low: roundToTick(info.market, low),
        close: roundToTick(info.market, close),
        volume: Math.round(volumeBase * (0.5 + rng())),
      });
      close = open;
    }
    return bars.reverse();
  }

  return {
    name: 'sim',

    async fetchQuotes(symbols) {
      await ensureSeeded();
      const ts = now();
      call++;
      return symbols.map((info): Quote => {
        const s = step(info, marketDate(info.market, ts));
        const price = roundToTick(info.market, s.price);
        return {
          symbol: info.symbol,
          market: info.market,
          price,
          change_pct: Math.round(((price - s.prevClose) / s.prevClose) * 10_000) / 100,
          volume: s.volume,
          ts,
          source: 'sim',
        };
      });
    },

    async fetchFx() {
      const w = await fxStart();
      const ts = now();
      const day = marketDate('KR', ts);
      if (day !== w.day) {
        w.prevClose = w.rate;
        w.day = day;
      }
      w.rate *= 1 + (w.rng() * 2 - 1) * FX_TICK_MOVE;
      const rate = Math.round(w.rate * 100) / 100;
      return {
        pair: 'USDKRW',
        rate,
        change_pct: Math.round(((rate - w.prevClose) / w.prevClose) * 10_000) / 100,
        ts,
        source: 'sim',
      };
    },

    async fetchDailyBars(info, days) {
      // Never overwrite stored (possibly real) history with synthetic bars.
      const stored = stmt('bars').all(info.symbol, days) as DailyBar[];
      if (stored.length > 0) return stored.reverse();
      await ensureSeeded();
      return generateBars(info, days);
    },
  };
}
