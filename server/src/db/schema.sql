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
  market TEXT NOT NULL CHECK (market IN ('KR','US','ALL')),
  currency TEXT NOT NULL CHECK (currency IN ('KRW','USD')),
  status TEXT NOT NULL CHECK (status IN ('recruiting','active','finished')),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  start_cash REAL NOT NULL,
  decision_interval_min INTEGER NOT NULL,
  max_orders_per_day INTEGER NOT NULL,
  fee_rate REAL NOT NULL,
  tax_rate REAL NOT NULL,           -- applied to SELL amount
  max_position_pct REAL NOT NULL DEFAULT 0.4, -- legacy: the per-symbol cap was removed (2026-11-02); not enforced
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
  trade_date TEXT NOT NULL,         -- market-local YYYY-MM-DD at placement (daily limit)
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
