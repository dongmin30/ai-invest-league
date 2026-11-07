# AI Invest League — MVP Spec (contract for all contributors)

This file is the single source of truth for module boundaries. If code and this file disagree, fix the code or update this file in the same change.

## 1. Stack

| Layer | Choice |
|---|---|
| Runtime | Node 22, TypeScript (ESM, `"type": "module"`), run with `tsx` in dev |
| Server | Fastify 5, `@fastify/cookie`, `@fastify/jwt`, `@fastify/rate-limit`, `@fastify/static` |
| DB | SQLite via `better-sqlite3` (file `server/data/app.db`, WAL mode). Synchronous API. |
| Validation | `zod` |
| LLM | `@anthropic-ai/sdk` (Claude), plain `fetch` to Ollama OpenAI-compatible API |
| Web | Vite + React 18 + TypeScript, `react-router-dom`, Tailwind CSS v3, `recharts` |
| Tests | `vitest` (server) |
| Repo | npm workspaces: `server`, `web`; shared types in `shared/api-types.ts` |

Ports: server `8787`, Vite dev `5173` (proxies `/api` to `8787`). In production `server` serves `web/dist`.

## 2. Layout and ownership

```
shared/api-types.ts          API DTOs (do not change shapes without updating both sides)
server/src/
  config.ts                  env parsing (zod) -> `config` object
  db/schema.sql              schema below
  db/db.ts                   `db` (better-sqlite3 instance), `migrate()`, `tx(fn)`
  lib/bus.ts                 typed EventEmitter `bus`
  lib/time.ts                `now()` (overridable in tests via `setNow`)
  market/                    symbols, calendar, providers, quote cache, collector
  engine/                    orders, matching, portfolio, ranking, leagues, snapshots
  agents/                    LLM providers, rule strategies, prompt, schema, runner, seed
  api/                       fastify app, auth, routes, SSE
  scheduler.ts               periodic jobs wiring (integration)
  index.ts                   bootstrap (integration)
server/test/                 vitest tests, mirroring src folders
web/src/                     React app
```

## 3. Environment (`.env`, all optional)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8787 | server port |
| `JWT_SECRET` | random per boot (warn) | cookie JWT secret |
| `ADMIN_EMAILS` | (empty) | comma list; when set it is authoritative: listed users are admins and every other user (including an earlier bootstrap admin) is demoted on their next request. Only when it is empty, the first registered user becomes admin (bootstrap; logged as a warning). |
| `PRICE_PROVIDER` | `yahoo` | `yahoo` (keyless), `kis` (needs KIS keys), `sim` (offline random walk) |
| `SIM_ALWAYS_OPEN` | `false` | treat both markets as open (for weekend/night demos; use with `sim`) |
| `COLLECT_INTERVAL_SEC` | 60 | quote polling interval |
| `KIS_APP_KEY`, `KIS_APP_SECRET` | — | Korea Investment Open API (real-account app key, quotes only) |
| `KIS_BASE_URL` | `https://openapi.koreainvestment.com:9443` | |
| `ANTHROPIC_API_KEY` | — | enables Claude agents (fund it with the Max plan's monthly API credit) |
| `CLAUDE_MODEL` | `claude-opus-5-5` | model for Claude agents |
| `CLAUDE_EFFORT` | `low` | `output_config.effort` |
| `OLLAMA_BASE_URL` | — | e.g. `http://localhost:11434`; enables Ollama agents when reachable |
| `OLLAMA_MODEL` | `qwen3:8b` | |
| `AGENT_TIMEOUT_SEC` | 60 | per decision, measured from when the job starts |
| `COOKIE_SECURE` | `NODE_ENV=production` | mark the session cookie `Secure` (set when served over HTTPS) |
| `TRUST_PROXY` | `false` | Fastify `trustProxy` (`true`/`false`, or comma-separated addresses/subnets such as `loopback`), so rate limits key on the client IP behind a reverse proxy. Prefer `loopback` over `true`, which lets a client-sent X-Forwarded-For choose the IP. `npm run share` uses `loopback` |
| `SIGNUP_CODE` | — | when set, `POST /auth/register` needs a matching `signup_code` (입장코드; case, spaces and hyphens ignored; NFKC-normalized, so full-width letters and Unicode dashes match too; at least 8 characters after stripping, else the server refuses to boot; checked before the email lookup, constant-time) or answers 403 `invalid_signup_code`. Logins are unaffected. `npm run share` uses it from the env files, or else writes a fresh `XXXX-XXXX` code per run into `server/data/share.env` (its overlay) and prints it with a `/register?code=` link; it refuses a `SIGNUP_CODE` in the committed `.env.share` and does not open the tunnel unless `/auth/signup-options` reports the code as required |
| `DATA_DIR` | `server/data` | folder for `app.db` and the KIS token cache; relative paths resolve against the repo root (use a separate folder for smoke boots) |
| `ENV_OVERLAY` | — | shell/process env only: path (relative to the repo root) of an extra env file loaded after `.env` with override, so its values win. `npm run practice` sets it to `.env.practice` (committed, no secrets: `sim`, `SIM_ALWAYS_OPEN`, 10 s collect, `DATA_DIR=server/data/practice`, blank `ANTHROPIC_API_KEY`). A missing file is a boot error. |

`.env` (then `server/.env`) is loaded with override, so shell variables do not beat values set there; use `ENV_OVERLAY` to change them for one run. Under Vitest no env file is loaded.

## 4. Database schema (`server/src/db/schema.sql`)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('claude','ollama','rule')),
  model TEXT NOT NULL,              -- 'claude-opus-5-5' | 'qwen3:8b' | 'baseline' | 'momentum'
  description TEXT NOT NULL DEFAULT '',
  strategy_prompt TEXT NOT NULL DEFAULT '',
  markets TEXT NOT NULL DEFAULT 'KR,US',
  enabled INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT
);

CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('3d','1w','1m','custom')),
  market TEXT NOT NULL CHECK (market IN ('KR','US','ALL')),  -- ALL = 통합 리그 (KR + US, one KRW account)
  currency TEXT NOT NULL CHECK (currency IN ('KRW','USD')),
  status TEXT NOT NULL CHECK (status IN ('recruiting','active','finished')),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  start_cash REAL NOT NULL,
  decision_interval_min INTEGER NOT NULL,
  max_orders_per_day INTEGER NOT NULL,
  fee_rate REAL NOT NULL,
  tax_rate REAL NOT NULL,           -- applied to SELL amount
  max_position_pct REAL NOT NULL DEFAULT 0.4, -- legacy, not enforced (per-symbol cap removed 2026-11-02)
  fx_spread REAL NOT NULL DEFAULT 0, -- FX conversion cost per side (ALL leagues; 0 otherwise)
  is_public INTEGER NOT NULL DEFAULT 1,
  invite_code TEXT,
  owner_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL REFERENCES leagues(id),
  user_id INTEGER REFERENCES users(id),
  agent_id INTEGER REFERENCES agents(id),
  cash REAL NOT NULL,
  joined_at INTEGER NOT NULL,
  last_decision_at INTEGER,
  final_rank INTEGER,
  final_return REAL,
  left_at INTEGER,                  -- set when a user forfeits an active league (see leaveLeague)
  CHECK ((user_id IS NULL) <> (agent_id IS NULL)),
  UNIQUE (league_id, user_id),
  UNIQUE (league_id, agent_id)
);

CREATE TABLE IF NOT EXISTS holdings (
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  symbol TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  avg_price REAL NOT NULL,          -- native currency
  avg_fx REAL NOT NULL DEFAULT 1,   -- applied FX of the cost basis, USD-amount weighted (1 unless US in an ALL league)
  PRIMARY KEY (participant_id, symbol)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  type TEXT NOT NULL CHECK (type IN ('MARKET','LIMIT')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  limit_price REAL,
  ref_price REAL NOT NULL,          -- quote price at placement (for cash reservation)
  ref_fx REAL,                      -- FX at placement for US orders in ALL leagues (BUY: spread-applied, reserves cash; SELL: mid)
  status TEXT NOT NULL CHECK (status IN ('pending','filled','canceled','rejected')),
  reject_reason TEXT,
  fill_price REAL,
  fee REAL,
  tax REAL,
  fx_rate REAL,                     -- applied FX at fill (US orders in ALL leagues)
  source TEXT NOT NULL CHECK (source IN ('user','agent')),
  trade_date TEXT NOT NULL,         -- market-local YYYY-MM-DD at placement (daily limit; ALL: leagueTradeDate)
  created_at INTEGER NOT NULL,
  filled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status, symbol);
CREATE INDEX IF NOT EXISTS idx_orders_participant ON orders(participant_id, created_at);

CREATE TABLE IF NOT EXISTS quotes (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE IF NOT EXISTS fx_rates (
  pair TEXT NOT NULL,               -- 'USDKRW'
  ts INTEGER NOT NULL,              -- source time of the rate (one row per tick, never replaced)
  rate REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (pair, ts)
);

CREATE TABLE IF NOT EXISTS daily_bars (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,               -- YYYY-MM-DD market-local
  open REAL, high REAL, low REAL, close REAL NOT NULL, volume REAL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS snapshots (
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  ts INTEGER NOT NULL,
  equity REAL NOT NULL,
  return_rate REAL NOT NULL,
  fx_rate REAL,                     -- USD/KRW mid the equity used (ALL leagues; null otherwise or before any rate)
  PRIMARY KEY (participant_id, ts)
);

CREATE TABLE IF NOT EXISTS decision_logs (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  league_id INTEGER NOT NULL REFERENCES leagues(id),
  ts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','hold','invalid','error','timeout')),
  market_view TEXT NOT NULL DEFAULT '',
  orders_json TEXT NOT NULL DEFAULT '[]',
  accepted_order_ids_json TEXT NOT NULL DEFAULT '[]',
  rejected_json TEXT NOT NULL DEFAULT '[]',
  prompt_summary TEXT NOT NULL DEFAULT '',
  raw_response TEXT,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decision_logs(agent_id, ts);
```

`migrate()` runs `schema.sql`, then widens `leagues.market`'s CHECK to `('KR','US','ALL')` on older databases (SQLite cannot alter a CHECK: the table is rebuilt from its stored DDL in `sqlite_master` — CHECK and table name string-replaced, throwing if the expected text is missing — with `foreign_keys` off around a transaction that creates `leagues_new`, copies every column, drops, renames, recreates indexes and requires an empty `foreign_key_check` for the foreign keys that reference `leagues` (child tables found via `pragma_foreign_key_list`: participants, decision_logs; an unrelated orphan elsewhere does not block the upgrade); skipped when the DDL already has `'ALL'`), then adds columns introduced after the first release (`ADDED_COLUMNS` in `db/db.ts`: `participants.left_at`, `leagues.fx_spread`, `orders.ref_fx`, `orders.fx_rate`, `holdings.avg_fx`, `snapshots.fx_rate`) with `ALTER TABLE … ADD COLUMN` when `PRAGMA table_info` lacks them, so existing databases upgrade in place without losing rows. Idempotent.

### 통합 (ALL) leagues in one paragraph
`LeagueMarket = 'KR' | 'US' | 'ALL'` (shared types; `Market` stays the symbol market). An ALL league trades every symbol from one KRW account. Native prices (`fill_price`, `avg_price`, `limit_price`, USD for US symbols) stay in the symbol's currency; cash, fees, taxes, values and P&L are KRW. US symbols convert at fill time at the USD/KRW mid × (1 ± `fx_spread`) (BUY +, SELL −; default 0.1% per side, "환전 비용"); each symbol pays its own market's fee/tax (`ratesFor`). Valuation uses the mid (also when stale). A unified trading day starts at 08:00 KST and holds the KR session and the following US session; league length, the daily order limit and official schedules count unified days.

## 5. Module interfaces (exact exports)

### lib
- `lib/bus.ts`: `export const bus` — typed emitter with events
  `'quotes'(quotes: Quote[])`, `'fx'(fx: FxQuote)`, `'order'(e: {league_id, participant_id, order: Order})`, `'rankings'(e: {league_id, rankings: RankingRow[]})`, `'decision'(e: {league_id, agent_id, agent_name, status, summary})`.
  Methods: `on(event, listener)`, `off(event, listener)`, `emit(event, payload)`.
- `lib/time.ts`: `now(): number`, `setNow(fn: (() => number) | null)` (tests only).

### market (owner: market agent)
- `market/symbols.ts`: `SYMBOLS: SymbolInfo[]` where `SymbolInfo = {symbol, name, market, exchange, yahoo: string, kisExchange?: 'NAS'|'NYS'|'AMS', kind: 'stock'|'etf', leverage: number, underlying?: string, category: string}`. `leverage` is the daily return multiple (1 for stocks and plain ETFs; 2/3 leveraged; -1/-2/-3 inverse; UVXY 1.5); `underlying` is the pool symbol a leveraged/inverse ETF multiplies (e.g. SQQQ → QQQ, 122630 → 069500; always a 1× symbol of the same market); `category` is a short Korean label. Pool (each entry verified live against Yahoo on 2026-10-31): KR 74 stocks (KOSPI + KOSDAQ large caps) + 31 KOSPI-listed ETFs (KODEX/TIGER index, leveraged, inverse, overseas index, sector, commodity, bond, FX), US 103 large-cap stocks + 60 ETFs (index, sector/theme, bonds, commodities, 14 leveraged, 14 inverse, UVXY) — 268 symbols. US ETF exchanges are `NASDAQ`, `NYSE Arca` or `Cboe BZX` (KIS EXCD `AMS` for the latter two). `getSymbol(symbol)`, `symbolsFor(market: LeagueMarket)` (`'ALL'` = every symbol; KR codes are 6 digits and US codes letters, so they never collide), `isLeveraged(info)` (`leverage !== 1`).
- `market/calendar.ts`:
  - `isMarketOpen(market: Market, at = now()): boolean` — KR 09:00–15:30 Asia/Seoul, US 09:30–16:00 America/New_York, Mon–Fri, minus holidays in `market/holidays.ts` (2026–2027 lists). Honors `config.simAlwaysOpen`.
  - `marketDate(market, at = now()): string` — YYYY-MM-DD in market timezone.
  - `nextOpen(market, at)`, `nextClose(market, at): number` (epoch ms).
  - `addTradingDays(market, startOpenAt: number, days: number): number` — returns the close time of the N-th trading day counting the day of `startOpenAt` as day 1.
  - `isTradingDay(market, date: string): boolean`.
  - `POST_CLOSE_FETCH_MS` (10 min; re-exported by `market/collector.ts`) and `closingPrintSession(market, at): number | null` — the session close when `at` falls in `(close, close + POST_CLOSE_FETCH_MS]` of a trading day (providers stamp the closing auction print a few seconds after the close, e.g. Yahoo KR 15:30:05 KST), else null (always null with `simAlwaysOpen`).
  - League calendars (`LeagueMarket`; KR/US delegate to the functions above). Sessions never overlap: KR 09:00–15:30 KST, US 22:30–05:00 KST (EDT) / 23:30–06:00 (EST). `isLeagueOpen(m, at)` (ALL: KR or US open); `leagueTradeDate(m, at)` (ALL: `marketDate('KR', at − 8 h)`, unified-day boundary 08:00 KST, `UNIFIED_DAY_START_HOUR_KST`; with `simAlwaysOpen` `marketDate('KR', at)`, matching the KR-calendar days `addLeagueTradingDays` counts); `isUnifiedTradingDay(date)` (KR or US trades); `unifiedSessionBounds(date)` — open = KR open if KR trades that day else US open, close = US close if the US trades else KR close; `isLeagueTradingDay`, `leagueSessionBounds`; `nextLeagueOpen(m, at)` (ALL: earlier of both `nextOpen`); `addLeagueTradingDays(m, from, n)` (ALL: close of the n-th unified trading day counting the unified day of `from` as day 1 — usually the US close the next morning KST; e.g. 3d from Mon 2026-11-02 09:00 KST ends Thu 06:00 KST, 1w Sat 06:00; a US holiday on the last day ends at the KR close, 2026-11-26; a KR holiday on the first day starts at the US open, 2026-12-31); `closingMarketOf(league)` — the market whose close is `end_at` (ALL: US if `end_at` is a US close, else KR). With `simAlwaysOpen` ALL follows the KR calendar and is always open.
- `market/fx.ts`: USD/KRW for ALL leagues. `getFx(at?) : FxQuote | null` (`stale` = older than `FX_STALE_MS`, 30 min), `setFx(tick)` (newest wins), `storeFx(tick)` (`fx_rates`, one row per source `ts` — exact, not floored — with `INSERT OR IGNORE`, so a stored rate is never overwritten and a re-fetched tick adds nothing), `fxAt(ts)` (last stored rate ≤ ts), `loadStoredFx()` (boot, right after `migrate()`: seeds the in-memory rate from the latest `fx_rates` row with its stored ts — usually stale, so US fills still wait for a fresh rate while valuation and US order placement work; never replaces a newer rate), `isFxStale`, `appliedFx(mid, side, spread)` = mid × (1 + spread) for BUY, × (1 − spread) for SELL (4 decimals), `DEFAULT_FX_SPREAD` 0.001, `FX_PAIR`.
- `market/providers/types.ts`: `interface PriceProvider { name: 'yahoo'|'kis'|'sim'; fetchQuotes(symbols: SymbolInfo[]): Promise<Quote[]>; fetchDailyBars(symbol: SymbolInfo, days: number): Promise<{date, open, high, low, close, volume}[]>; fetchDailyBarsMany?(symbols, days): Promise<Map<symbol, DailyBar[]>>; fetchFx?(): Promise<FxTick> }` (the optional batch omits symbols it could not load; `FxTick = Omit<FxQuote, 'stale'>`, rejects on failure).
- `market/providers/yahoo.ts`: batched first through `https://query1.finance.yahoo.com/v7/finance/spark?symbols=A,B,…&range=1d&interval=1d` (keyless, browser User-Agent; **at most 20 symbols per call** — `SPARK_MAX_SYMBOLS`, Yahoo answers 400 above that). Each `spark.result[].response[0]` has the same `meta` as a chart response, so quotes parse identically: `meta.regularMarketPrice`, `regularMarketTime`*1000 (KR closing print 15:30:0x KST, so the closing-print logic is unchanged), `regularMarketVolume`, change vs `previousClose`/`chartPreviousClose`. Tickers a successful spark response lacks (unknown ticker, no price) fall back to the per-symbol chart `https://query1.finance.yahoo.com/v8/finance/chart/{yahoo}?interval=1m&range=1d` (option `fallback`, default true; `batch: false` uses only the chart path). A chunk whose call fails as a whole (HTTP error after one retry, network error) is skipped, not re-fetched per symbol (that turned one 429 into 20 more requests); its symbols keep their cached quotes until the next tick. Circuit breaker: a 429 that persists after the retry pauses every request of that provider instance for `YAHOO_COOLDOWN_MS` (60 s, options `cooldownMs`/`clock`), logged once; while paused `fetchQuotes` returns `[]`, `fetchDailyBarsMany` an empty map and other calls reject without a request (`YahooError` status 429). Daily bars: `fetchDailyBarsMany` via spark `range={rangeForDays(days)}&interval=1d` — closes only, open/high/low/volume null (nothing reads them; the per-symbol chart fallback `interval=1d` keeps full OHLCV). A full refresh is ⌈n/20⌉ requests (US 163 symbols → 9, KR 105 → 6). Throttle: max 4 concurrent requests. `v7/finance/quote` is not used (401). USD/KRW (`fetchFx`): its own chart call `…/v8/finance/chart/KRW%3DX?interval=1m&range=1d` (never inside spark chunks): `meta.regularMarketPrice` (else the last 1m close), `regularMarketTime`*1000, change vs `previousClose`/`chartPreviousClose` (fixture captured live 2026-10-31: 1335.1, prev 1338.99). Export pure parse functions (`parseYahooQuote`, `parseYahooDailyBars`, `parseYahooSpark`, `parseYahooFx`) for tests.
- `market/providers/kis.ts`: token `POST /oauth2/tokenP` (cache 23h, in memory + `server/data/kis-token.json`), domestic `GET /uapi/domestic-stock/v1/quotations/inquire-price` tr_id `FHKST01010100` (`FID_COND_MRKT_DIV_CODE=J`, `FID_INPUT_ISCD`), overseas `GET /uapi/overseas-price/v1/quotations/price` tr_id `HHDFS00000300` (`AUTH=''`, `EXCD`, `SYMB`). Rate limiter 15 req/s (KIS allows about 20 req/s per real-account app key); quotes are one request per symbol, so a full US refresh (~160 symbols) takes ~11 s and KR ~7 s, within the 60 s collect interval. US EXCD: `NAS`, `NYS`, `AMS` (NYSE Arca / Cboe ETFs); domestic ETFs use the same `inquire-price` call as stocks. Daily bars and `fetchFx` delegate to yahoo (including `fetchDailyBarsMany`). Marked "untested until keys are provided". Export pure parse functions for tests.
- `market/providers/sim.ts`: `createSimProvider({seed?, seedFx?, seedTimeoutMs?})` — deterministic-seeded random walk; ±0.3% per tick (×|leverage| for leveraged products without an underlying). Start price: latest DB quote, else latest `daily_bars` close, else a real latest quote from `seed` (called once, before the first quote or generated bar, for symbols with no stored price; `market/index.ts` passes a spark-only Yahoo fetch; failure or a 10 s timeout is logged and ignored), else `BASE_PRICES` (every symbol, Yahoo closes of 2026-10-30). An ETF with `underlying` does not walk on its own: each tick its return is `leverage` × the underlying's return since the ETF's previous tick (SQQQ = −3 × QQQ); the underlying steps once per `fetchQuotes` call even when not requested, so paths do not depend on which symbols are requested. `fetchFx`: deterministic ±0.02%/tick walk (seed `'USDKRW'`) from the latest `fx_rates` row, else `seedFx` (real Yahoo rate, once; `market/index.ts` passes Yahoo `fetchFx`), else `SIM_FX_BASE` (1335.1); change vs the walk's start of the KR day; `ts = now()`.
- `market/quoteCache.ts`: `getQuote(symbol): Quote | undefined`, `getQuotes(market?): Quote[]`, `setQuotes(quotes: Quote[])` (also called by tests; replaces a symbol's quote only when `q.ts >= cached.ts`, so an older fetch never overwrites a newer quote), `isStale(q, at)`.
- `market/collector.ts`: `createCollector(provider): { tick(): Promise<Quote[]>; loadDailyBars(): Promise<void> }`. `tick()` fetches quotes only for markets that are open (plus one initial fetch for all markets on boot so prices exist), writes `quotes` rows (one per symbol per minute), updates cache, emits `bus 'quotes'`. When the provider has `fetchFx`, it also fetches USD/KRW once per tick (in parallel, separate call) while either market is open or in its closing-print window, or until this collector has fetched one (a rate seeded by `loadStoredFx` at boot does not count, so a restart while both markets are closed still refreshes it once); `storeFx`, `setFx`, `bus 'fx'` (failures are logged). Both settle before `tick()` resolves. `loadDailyBars()` calls `provider.fetchDailyBarsMany` when present, then `fetchDailyBars` per symbol for whatever the batch missed. `getDailyCloses(symbol, n): number[]` from `daily_bars`.
- `market/index.ts`: `getProvider(): PriceProvider` per `config.priceProvider`; `marketStatus(market): MarketStatus`.

### engine (owner: engine agent)
- `engine/fees.ts`: `LEAGUE_DEFAULTS[leagueMarket]` → `{currency, start_cash, fee_rate, tax_rate, fx_spread}`: KR `{KRW, 10_000_000, 0.00015, 0.002, 0}`, US `{USD, 10_000, 0.001, 0, 0}`, ALL `{KRW, 10_000_000, 0.00015, 0.002, 0.001}` (ALL stores the KR rates; trades use `ratesFor`). `typeDefaultsFor(type, market)`: `TYPE_DEFAULTS[type]` for KR/US; ALL (two sessions per unified day: half the decision frequency, 1.5× orders) 3d `{3, 60, 30}`, 1w `{5, 120, 15}`, 1m `{20, 360, 8}`, custom `{n, 120, 15}`. `ratesFor(league, symbol)` → `{fee_rate, tax_rate}`: single-market leagues use their columns + `taxRateFor`; ALL uses `LEAGUE_DEFAULTS[symbol market]` + `taxRateFor` (KR stock 0.015% + 0.2% SELL tax, KR ETF no tax, US 0.1%). `convertsFx(leagueMarket, symbol)` — US symbol in an ALL league. `tradeCost(currency, side, qty, price, feeRate, taxRate, fx = 1)`: `amount = roundMoney(currency, qty × price × fx)`, fee/tax on the converted amount. `TYPE_DEFAULTS[type]` → `{trading_days, decision_interval_min, max_orders_per_day}`: 3d `{3, 30, 20}`, 1w `{5, 60, 10}`, 1m `{20, 180, 5}`, custom `{n, 60, 10}`. `roundMoney(currency, v)` (KRW 0 decimals, USD 2). `taxRateFor(symbol, leagueTaxRate)` — Korean ETFs are exempt from the securities transaction tax: 0 for KR ETFs, the league rate (KR stocks 0.20%, US 0) otherwise.
- `engine/orders.ts`:
  - `placeOrder(participantId: number, req: PlaceOrderRequest, source: 'user'|'agent'): Order` — throws `EngineError(code, messageKo)` on: league not active, market closed is NOT an error (order stays pending until next quote while open), symbol not in league market pool, quantity not a positive integer, LIMIT without positive limit_price, no quote yet, daily limit reached (`trade_date` count of non-rejected orders ≥ `max_orders_per_day`), BUY: `qty*price*(1+fee)` > available cash, SELL: qty > holding qty − pending sell qty. Codes: `league_inactive`, `bad_symbol`, `bad_quantity`, `bad_limit`, `no_quote`, `daily_limit`, `insufficient_cash`, `insufficient_shares`, `participant_left` (the participant forfeited the league), `session_after_end` (the symbol's market is closed and its `nextOpen` is after `end_at`: '리그 종료 전에 이 종목의 장이 열리지 않습니다.'), `no_fx` (US symbol in an ALL league before any USD/KRW rate exists). ALL leagues: the pool is every symbol; the daily count uses `leagueTradeDate` (one limit per unified day); a US BUY reserves `qty × price × appliedFx(mid, BUY, fx_spread)` + fee (stored as `ref_fx`; SELL stores the mid), and the position cap values the position at the mid; fees per `ratesFor`. A stale rate does not block placement.
  - `cancelOrder(orderId: number, participantId: number): Order` (pending only).
  - `export class EngineError extends Error { code: string }`.
- `engine/matcher.ts`: `matchOrders(quotes: Quote[]): Order[]` — for each pending order whose symbol has a quote with `ts > order.created_at` **and** the market is open: MARKET fills at that quote price; BUY LIMIT fills if price ≤ limit (at quote price); SELL LIMIT if price ≥ limit. Quotes with `ts > league.end_at` never fill (a league stays `active` until the next status update). Exception, the closing print: a quote stamped in `(close, close + POST_CLOSE_FETCH_MS]` (`closingPrintSession`) counts as stamped at that session's close, so it fills orders with `created_at <= close` (and `< ts`), including in a league whose `end_at` is that close; orders placed after the close wait for the next session (KRX 15:20–15:30 is a closing call auction with no prints, so orders placed then fill at the closing print). On fill (one transaction): re-check cash/shares (reject with reason if now invalid; a BUY may not spend cash reserved by the participant's other pending BUYs, so `available_cash` never goes negative; the free cash is `roundMoney`-ed before the comparison, so an exactly affordable USD order is not rejected by float error), fee = amount×fee_rate, tax = SELL amount×`taxRateFor(symbol, tax_rate)` (0 for KR ETFs), update cash and holdings (weighted avg price on BUY; delete row at 0 qty). Emits `bus 'order'`. Pending orders of finished leagues are canceled by `finishLeague`. ALL leagues: a quote of either market matches orders of ALL leagues too (`l.market IN (?, 'ALL')`); US orders need a non-stale USD/KRW (else they stay pending) and fill at `appliedFx(mid, side, fx_spread)` (stored as `orders.fx_rate`), cost via `ratesFor` + `tradeCost(…, fx)`; the order's own reservation uses its `ref_fx`, so a rate rise beyond the free cash rejects the BUY; `holdings.avg_fx` = (q0·p0·f0 + q·p·f) / (q0·p0 + q·p) with the applied rate.
- `engine/portfolio.ts`: `getPortfolio(participantId): Portfolio` (for a finished league, `equity`/`return_rate` are the final snapshot's and holdings are priced at the last stored quote at or before it — and US holdings of ALL leagues at the snapshot's `fx_rate`, else (snapshots older than that column) `fxAt(final.ts)` — so the portfolio matches the frozen result); `equityOf(participantId): number` (cash + Σ qty × last price × markFx; falls back to avg_price when no quote; markFx = USD/KRW mid for US symbols in ALL leagues, even when stale (after a restart the last stored rate, see `loadStoredFx`); the `avg_fx` fallback applies only when no rate exists at all — none fetched and none stored; 1 otherwise); `availableCash(participantId)` (reservations use `ratesFor` fee and `ref_fx`). Holdings carry `currency` (native), `fx_rate` (rate used for `value`), `value`/`pnl` in the league currency with `pnl = value − qty × avg_price × avg_fx`; `orders_today` by `leagueTradeDate`; `Portfolio.fx` = `getFx()` for ALL leagues, else null.
- `engine/ranking.ts`: `computeRankings(leagueId): RankingRow[]` — eligible = ≥1 filled order; sort eligible by return desc, then MDD desc (closer to 0 first), then trade_count asc; ineligible after with `rank: null`. Participants with `left_at` set are not listed (so they are also out of averages, equity series and final ranks). `mddOf(participantId)` from snapshots + current equity. `leagueAverages(leagueId)` → `{human_avg_return, ai_avg_return, baseline_return}`.
- `engine/snapshots.ts`: `takeSnapshots(leagueId?)` — insert snapshot per participant (except those who left) of active leagues; ALL leagues also store the USD/KRW mid the equity used (`snapshots.fx_rate`, null without a rate); `getEquitySeries(leagueId, viewerParticipantId|null): EquitySeries[]` (top 10 humans + all AI + viewer).
- `engine/leagues.ts`:
  - `createLeague(input: {name, market: LeagueMarket, type, duration_days?, start_cash?, is_public, owner_id|null, start_at?: number, agent_ids?: number[]}): LeagueSummary` — computes `start_at` (given or `nextLeagueOpen`), `end_at = addLeagueTradingDays(...)` (counted from `start_at` when `isLeagueOpen` then, else the next open), defaults from fees.ts (`LEAGUE_DEFAULTS[market]` incl. `fx_spread`, `typeDefaultsFor`), `invite_code` (6 chars, unique among unfinished leagues) for non-public; status `active` if start_at ≤ now else `recruiting`; joins given agents.
  - `joinLeague(leagueId, {userId?|agentId?}, inviteCode?): number` (participant id) — per `isJoinable(league)`: while `recruiting`, while `active` for `custom` leagues, and for official leagues during the first 24 h after `start_at` (`OFFICIAL_JOIN_GRACE_MS` in fees.ts); errors `league_closed`, `already_joined`, `bad_invite`, `left_league` (the user forfeited this league; no rejoin).
  - `leaveLeague(leagueId, userId): {forfeited: boolean}` — users only (AI participants never leave). `recruiting`: deletes the participant and its orders/holdings/snapshots (they may join again; `forfeited: false`). `active` before `end_at`: forfeit — cancels pending orders (`reject_reason` `리그에서 나가 취소되었습니다.`), sets `participants.left_at`, keeps holdings as they are (not liquidated); the participant drops out of rankings, averages, snapshots, `hasClosingQuotes`, `myDashboard`, `joined`/`my_participant_id`/`participant_count` (summary `left: true`), private-league visibility and `listLeagues`, and `placeOrder` refuses it (`participant_left`); `forfeited: true`. Emits `bus 'order'` for canceled orders and `'rankings'` for the league. Errors: `league_finished` (finished, or active past `end_at`), `not_joined`, `not_found`.
  - `countOpenOwnedLeagues(ownerId)` — unfinished leagues the user owns **and still takes part in** (a non-left participant); leaving frees a slot of the 3-league cap (`owner_id` stays, so the owner keeps seeing the league and its invite code). Creation stays bounded by the 10/hour/IP rate limit.
  - `joinLeagueByCode(userId, code): {league_id, participant_id}` — resolves the private league from its invite code (case-insensitive), then `joinLeague`; unknown code → `bad_invite`.
  - `canViewLeague(league, userId): boolean` — public, or the user owns or joined it (and has not left). Private leagues are a 404 for everyone else (admins see all) on `GET /leagues/:id`, `/leagues/:id/equity`, `/stream`, AI participants' portfolio/orders, and the participations/decisions in `GET /agents/:id`.
  - `listLeagues(viewerUserId|null, filter: {status?, market?}): LeagueSummary[]`; `getLeagueSummary(id, viewerUserId|null)`.
  - `ensureOfficialLeagues()` — for each league market KR/US/ALL and type 3d/1w/1m (9 series), ensure one non-finished official league exists; auto-joins enabled agents for that market (ALL: agents whose `markets` include both KR and US). Names like `KR 1주 리그 #12`, `통합 1주 리그 #1`. `nextScheduledStart(market: LeagueMarket, …)` uses unified days for ALL (e.g. Monday's KR open; the US open on a KR-only holiday).
  - `updateLeagueStatuses()` — recruiting→active at start_at; active→finished after end_at once every symbol held in the league or with a pending order there has a cached quote with `ts ≥ end_at` (the closing print, so pre-close orders get their chance to fill at it first; `hasClosingQuotes(leagueId, closeAt, closingMarketOf(league))` — with a market, only that market's symbols count, so an ALL league ending at the US close ignores KR symbols), or at `end_at + POST_CLOSE_FETCH_MS` (10 min, `market/calendar.ts`) at the latest: cancel pending orders, final snapshot, store `final_rank`/`final_return`.
  - `myDashboard(userId): DashboardCard[]` (leagues the user left are not shown).

### agents (owner: agents agent)
- `agents/schema.ts`: zod `DecisionSchema = { market_view: string ≤ 300, orders: [{ symbol: string, side: 'BUY'|'SELL', quantity: int ≥ 1, reason: string ≤ 200 }] ≤ 5 }` plus `decisionJsonSchema` (JSON Schema with `additionalProperties: false`, every property required).
- `agents/types.ts`: `interface DecisionInput { agent: AgentRow; league: LeagueSummary; rules: LeagueRules; portfolio: Portfolio; pendingOrders; candidates: CandidateRow[]; marketOpen: boolean; marketsOpen: Partial<Record<Market, boolean>>; fx: FxQuote | null; now: number }` (`marketOpen` = `isLeagueOpen`; `fx` only for ALL), `LeagueRules = {fee_rate, tax_rate, fx_spread, rates: Partial<Record<Market, {fee_rate, tax_rate}>>}`, `CandidateRow = {symbol, name, market, market_open, kind, leverage, underlying?, price, change_pct, volume, closes_5d: number[], price_krw?}` (`price` native; `price_krw` only in ALL leagues: KR = price, US = round(price × mid), null without a price or rate); `interface LLMProvider { decide(input: DecisionInput, signal: AbortSignal): Promise<{ decision: Decision; raw: string; input_tokens?: number; output_tokens?: number }> }`.
- `agents/prompt.ts`: `buildPrompt(input): {system: string; user: string}` — Korean system prompt with league rules (fees, tax incl. the KR ETF exemption, daily limit, no shorting/margin; leveraged/inverse ETFs may be bought with cash and decay when held), output contract, and candidates as a data block (`kind`/`leverage`/`underlying` are sent only for ETFs, keeping stock rows compact); when candidates include leveraged/inverse ETFs, a line lists them (`TQQQ(레버리지 3배, 기초 QQQ)`) with a decay warning; untrusted text is fenced as data. ALL leagues: "한국·미국 주식과 ETF를 하나의 원화 계좌로", fee/tax per market, the FX conversion rule (spread, stale-rate wait), the non-overlapping sessions and `session_after_end`, both market statuses (KST, plus New York time), an FX line (mid, applied BUY/SELL rates, time, stale flag or "정보 없음"), and candidate rows with `market`, `currency`, `market_open` (+ `price_krw` for US); single-market prompts are unchanged.
- `agents/providers/claude.ts`: Anthropic SDK, `client.beta.messages.create({ model: config.claudeModel, max_tokens: 2000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: config.claudeEffort, format: { type: 'json_schema', schema: decisionJsonSchema } }, system, messages })` (no `thinking` param, no temperature). Check `stop_reason === 'refusal'` → error. Read the first `text` block, `JSON.parse`, zod-validate. Typed SDK errors (`Anthropic.RateLimitError`, `APIConnectionError`, `APIError`) mapped to error messages. Usage tokens from `response.usage`.
- `agents/providers/ollama.ts`: `POST {OLLAMA_BASE_URL}/v1/chat/completions` with `response_format: {type: 'json_schema', json_schema: {name: 'decision', schema, strict: true}}`, `temperature: 0`, `stream: false`; parse `choices[0].message.content`; strip `<think>…</think>` if present.
- `agents/strategies/baseline.ts`: on first decision, buy equal weight across the 10 largest-volume **stock** candidates (ETFs never, so the benchmark is a diversified stock portfolio) using ~95% of cash; afterwards hold. `strategies/momentum.ts`: sell holdings with change_pct < −2%, buy up to 2 top gainers (> +1%) with ≤ 20% of equity each — stocks and plain 1× ETFs only (leveraged/inverse moves are a multiple of an index, not a trend of their own, and they decay). Both implement `LLMProvider` (no network) and emit at most 5 orders per decision (the baseline build spans two decisions). ALL leagues: the baseline buys 5 KR + 5 US stocks by KRW traded value (`price_krw × volume`) among those whose share price fits one equal-weight slot, only from markets open at that decision (at most 5 names per market), and momentum trades only `market_open` candidates. Sizing (`strategies/sizing.ts`) uses `price_krw ?? price`, the symbol market's fee and, for US symbols in ALL leagues, the FX spread.
- `agents/runner.ts`:
  - `selectCandidates(league, portfolio, pendingOrders = []): CandidateRow[]` — keeps the prompt small with a 100–160 symbol pool: holdings, pending-order symbols, core index ETFs (`CORE_CANDIDATES`: KR 069500/229200, US SPY/QQQ/DIA/IWM), then the top `CANDIDATE_MOVERS` (15) by \|change_pct\| / max(1, \|leverage\|), then the highest traded value (price × volume), then pool order for unquoted symbols, up to `MAX_CANDIDATES` (40; held/pending symbols are always included). At most `MAX_LEVERAGED_CANDIDATES` (6) leveraged/inverse ETFs enter through ranking. Deterministic (ties by symbol); same rule for every agent. ALL leagues: core ETFs of both markets (6), then the remaining R = 40 − forced slots go ceil(R × `OPEN_MARKET_SHARE` 0.6) to the open market and the rest to the closed one (half each, KR first, when both or neither are open), movers 9/6 and leveraged 3/3 (`ALL_MOVERS_SPLIT`, `ALL_LEVERAGED_SPLIT`), traded value ranked within each market only (`rankMarket`).
  - `runDecision(participantId): Promise<DecisionLog>` — builds input, calls provider with `AbortSignal.timeout(config.agentTimeoutSec*1000)`, validates every provider result (rule strategies included) with `DecisionSchema` (failure → `invalid`), then re-validates every order: symbol must be in the league market's whole pool (ALL: every symbol) or holdings, not only the candidates shown (`unknown_symbol`), then `placeOrder(..., 'agent')`; collects accepted ids/rejections; writes `decision_logs`; updates `participants.last_decision_at`; emits `bus 'decision'`. Failure → status `invalid`/`error`/`timeout` and no orders (HOLD).
    At most one decision per participant runs at a time (`isDecisionRunning(participantId)`; a second call throws `EngineError('agent_busy')`).
  - `runDueAgents(): Promise<void>` — for every active league whose market is open (`isLeagueOpen`; ALL: either market), every AI participant with `last_decision_at` null or older than `decision_interval_min`: run sequentially (one at a time per provider), skipping participants already deciding — never throws.
  - `getAgentDetail(agentId): AgentDetail`, `listAgents(): AgentInfo[]`.
- `agents/seed.ts`: `seedAgents()` upserts: `Claude 트레이더` (claude, `config.claudeModel`, enabled iff `ANTHROPIC_API_KEY`), `로컬 LLM 트레이더` (ollama, `config.ollamaModel`, enabled iff `OLLAMA_BASE_URL` reachable at boot `GET /api/tags`), `기준선 봇` (rule, `baseline`), `모멘텀 봇` (rule, `momentum`). Sets `disabled_reason` in Korean.

### api (owner: api agent)
- `api/app.ts`: `buildApp(opts?: {logger?: boolean}): Promise<FastifyInstance>` (used by tests via `app.inject`). Registers cookie, jwt (cookie name `token`, httpOnly, sameSite `lax`, 7d), rate-limit on `/api/auth/*` (10/min/IP), routes, security headers on every response (`X-Content-Type-Options`, `Referrer-Policy`, CSP with `frame-ancestors 'none'`), error handler mapping `EngineError` → 400 `{error: code, message}`, zod errors → 400 `validation`, 401 `unauthorized`, 403 `forbidden`, 404 `not_found`. Serves `web/dist` if it exists with SPA fallback.
- Endpoints (all JSON, prefix `/api`). Auth required unless noted:

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | /health | (public) | `{ok: true, provider, time}` |
| GET | /auth/signup-options | (public) | `SignupOptions` `{signup_code_required}` |
| POST | /auth/register | `{email, password(≥8), nickname(2–20), signup_code?}` (public; `signup_code` required when `SIGNUP_CODE` is set, else ignored) | `{user: User}` + cookie |
| POST | /auth/login | `{email, password}` (public) | `{user: User}` + cookie |
| POST | /auth/logout | | `{ok: true}` |
| GET | /auth/me | | `{user: User}` or 401 |
| GET | /me/dashboard | | `DashboardCard[]` |
| GET | /leagues | `?status=&market=` (`KR`/`US`/`ALL`) | `LeagueSummary[]` (public leagues + leagues I joined) |
| POST | /leagues | `CreateLeagueRequest` (`market` KR/US/ALL; start cash KR and ALL 10만~100억원, US $100~$10,000,000; ALL agents must trade both markets) | `LeagueSummary` (type `custom`, owner = me, owner auto-joins). 10/hour/IP; non-admins: at most 3 unfinished owned leagues they still take part in (`league_limit`) and rule agents only (LLM agents → 403) |
| POST | /leagues/:id/join | `{invite_code?}` | `{participant_id}` (20/min/IP). A private league the user cannot view is a 404 when no invite code or a malformed one (not 6 letters/digits) is sent; a well-formed wrong code is 400 `bad_invite` |
| POST | /leagues/:id/leave | | `LeaveLeagueResponse` `{ok: true, forfeited}` — see `leaveLeague`; same 404 visibility as `GET /leagues/:id`; 400 `league_finished` / `not_joined` |
| POST | /leagues/join-by-code | `{invite_code}` (6 chars) | `{league_id, participant_id}` — joins a private league without seeing it first (20/min/IP; `bad_invite` for unknown codes) |
| GET | /leagues/:id/invite | | `{invite_code: string \| null}` (null for public leagues) — owner or admin only (403), 404 when not visible |
| GET | /leagues/:id | | `LeagueDetail` |
| GET | /leagues/:id/equity | | `EquitySeries[]` |
| GET | /participants/:id/portfolio | | `Portfolio` (any participant, to anyone who can view the league — shown under 랭킹 "보유 종목") |
| GET | /participants/:id/orders | `?status=` | `Order[]` newest first, max 100 (owner, or AI) |
| POST | /participants/:id/orders | `PlaceOrderRequest` | `Order` (owner only) |
| DELETE | /orders/:id | | `Order` (owner only) |
| GET | /market/:market/symbols | `market` KR/US/ALL (ALL: both pools, 268 rows) | `SymbolRow[]` |
| GET | /market/:market/status | `market` KR/US | `MarketStatus` |
| GET | /market/fx | | `FxQuote \| null` (USD/KRW mid; null before the first fetch) |
| GET | /market/quote/:symbol/intraday | | `{symbol, points: {ts, price}[]}` from `quotes` today |
| GET | /agents | | `AgentInfo[]` |
| GET | /agents/:id | | `AgentDetail` |
| POST | /admin/agents/:id/run | `{league_id}` (admin) | `DecisionLog` (forces a decision now; 409 `agent_busy` if one is running) |
| POST | /admin/collect | (admin) | `{count}` (forces a quote tick) |
| GET | /stream | `?league_id=` | SSE (`text/event-stream`), events = `StreamEvent` JSON in `data:`; quotes for the league market (ALL: every quote, plus `fx` events), rankings/decision/order for that league; a named `event: ping` (`data: {}`) on open and every 20s as heartbeat — the web client falls back to polling (15s) when no ping arrives, e.g. behind a proxy that buffers SSE; at most 5 open streams per user (429 `too_many_streams`) |

### scheduler / index (owner: integration)
- `scheduler.ts`: `startScheduler()`: every `COLLECT_INTERVAL_SEC` → `collector.tick()` then `matchOrders(quotes)` then recompute rankings for active leagues and emit `'rankings'`; every 60s → `updateLeagueStatuses()`, `ensureOfficialLeagues()`, `runDueAgents()`; every 10 min → `takeSnapshots(id)` for active leagues whose market is open (ALL leagues while either market is open, once per run), and once per market close for that market's leagues (ALL leagues at both closes, `hasClosingQuotes(id, close, market)` counting only that market's symbols) (after a fresh quote fetch, not the collect run already in flight), taken when every held or pending-order symbol of those leagues has a quote with `ts ≥` the session close (`hasClosingQuotes`), or at close + `POST_CLOSE_FETCH_MS` at the latest. All jobs are guarded against overlap and never crash the process.
- `index.ts`: load `.env` (`dotenv`), `migrate()`, `loadStoredFx()`, `seedAgents()`, `collector.loadDailyBars()` (non-blocking), `ensureOfficialLeagues()`, `buildApp()`, listen, `startScheduler()`.

## 6. Web (owner: web agent)

Korean UI. Pages: `/login`, `/register` (shows an 입장코드 field when `/auth/signup-options` says so, prefilled from `?code=`), `/` (multi-league dashboard cards), `/leagues` (tabs 모집중/진행중/종료, market filter KR/US, join, "초대 코드로 참가" form, "커스텀 리그 만들기" modal incl. `start_now` and agent picker), `/leagues/:id` (`?invite=CODE` shows a join-by-code card to outsiders; owners of private leagues see the invite code and share link; countdown, rankings table with 사람/AI badges and model name, Recharts line chart of `EquitySeries`, 인간 평균 vs AI 평균 vs 기준선, link to trade, "리그 나가기" with a confirm dialog for joined unfinished leagues — also on dashboard cards; recruiting: can rejoin any time, active: forfeit, holdings not liquidated, out of the rankings, no rejoin; a left league shows a notice instead of the join button), `/leagues/:id/trade` (market status banner, symbol list with live prices via SSE — search by name/code/category, filter chips 전체/주식/ETF/레버리지·인버스, scrollable body with sticky header, badges `ETF`/`2x`/`3x`/`인버스`/`-2x` — order panel MARKET/LIMIT with KR ETF tax exemption in the estimate and a warning for leveraged/inverse products, holdings, pending orders with cancel, remaining orders today), `/agents`, `/agents/:id` (decision log timeline with reasons and statuses). Global footer: `가상자금으로 하는 교육용 모의투자입니다. 투자 권유가 아닙니다.` and price source + timestamp. API client in `web/src/api/client.ts` using `fetch` with `credentials: 'include'`; types imported from `../../shared/api-types` (path alias `@shared`). Number formatting: KRW `1,234,567원`, USD `$1,234.56`, percent with sign and color (up red / down blue, Korean convention). 통합 (ALL) leagues: violet `통합 KR+US` badge; `/leagues` market chips 전체/국내/미국/통합 (전체 = no filter, 통합 sends `market=ALL`); create modal third option 통합 (KRW, KR start-cash default; only agents trading both KR and US are selectable). Trade screen loads `/market/ALL/symbols`, shows both market banners (`/market/KR/status` + `/market/US/status`) and an `FxBadge` (USD/KRW · time, amber when older than 30 min; initial `/market/fx`, then stream `fx` events, also on the league page); symbol list gets 국내/미국 chips and a KRW equivalent under US prices; holdings revalue US positions at the live mid (native prices, KRW value/P&L); the order form uses the selected symbol's market for fee/tax (KR ETF exemption), open state and price step, and for US symbols shows the USD limit with `≈ 원 (적용 환율)`, 환전 비용 and a KRW max-buy including spread and fee; order history shows `체결가 $x · 환율 y`.

## 7. Rules that tests must cover
1. Market order fills only at a quote with `ts > created_at` while open.
2. Fee on both sides, tax on SELL only (none for KR ETFs), cash/holdings/avg price math.
3. Available cash reservation for pending BUY orders; daily limit; position cap; insufficient shares incl. pending sells.
4. Ranking order, eligibility, MDD.
5. Agent output: schema rejects extra/missing fields; unknown symbol rejected; timeout → HOLD log.
6. Calendar: open/closed at boundaries in both timezones, weekends, holidays, `addTradingDays`.
7. Provider parsers against fixture JSON (yahoo chart + spark, kis); spark chunking (≤ 20/call), per-symbol fallback (missing tickers only, never a failed chunk), 429 cooldown, batched daily bars in the collector; sim leverage relationship and seeding.
10. Symbol universe integrity (unique codes, suffix/exchange per market, leverage only on ETFs, underlyings exist); candidate cap and selection; baseline buys stocks only, momentum skips leveraged/inverse.
8. API: register → login cookie → join league → place order → portfolio; 401 without cookie; cannot order on someone else's participant; private league invite: owner reads the code, outsider joins by code.
9. Leaving a league: recruiting removes the participant (rejoin allowed); active forfeits (pending orders canceled, out of rankings/dashboard/averages, orders refused, no rejoin); finished refused; migration adds `left_at` to an old DB without data loss.
11. 통합 (ALL) leagues: unified calendar (08:00 KST boundary, session gap, KR/US-only holidays, DST, simAlwaysOpen); `ratesFor` and FX rounding; both pools, US BUY reservation/cap with spread, `no_fx`, `session_after_end`, shared daily limit; US fills in KRW with `fx_rate`, KR ETF tax exemption, KR orders waiting for the KR open, stale FX pending, FX-rise reject, `avg_fx`; KRW valuation (FX +1% → +1%, finished leagues at the final snapshot's `fx_rate` (unchanged by a later same-minute rate), restart seeding from `fx_rates`, P&L incl. FX); 9 official leagues, agents trading both markets, US-close finish, close snapshots per market; candidate split, whitelist, baseline 5/5, momentum open-market only, prompt FX line; migration rebuild of an old leagues DDL (twice) with FKs intact (only FKs to leagues checked); Yahoo `KRW=X` fixture, deterministic sim FX; API create/list/symbols ALL, `/market/fx`, stream fx.
