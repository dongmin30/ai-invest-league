import { afterEach, describe, expect, it } from 'vitest';
import { db, migrate, resetDb } from '../../src/db/db';

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
}

afterEach(() => resetDb());

describe('migrate', () => {
  it('adds participants.left_at to a database created before it existed, keeping rows', () => {
    resetDb();
    db.exec('ALTER TABLE participants DROP COLUMN left_at');
    expect(columns('participants')).not.toContain('left_at');
    const leagueId = Number(
      db
        .prepare(
          `INSERT INTO leagues (name, type, market, currency, status, start_at, end_at, start_cash, decision_interval_min,
                                max_orders_per_day, fee_rate, tax_rate, created_at)
           VALUES ('옛 리그', '1w', 'KR', 'KRW', 'active', 0, 1, 10000000, 60, 10, 0.00015, 0.002, 0)`,
        )
        .run().lastInsertRowid,
    );
    const userId = Number(
      db.prepare("INSERT INTO users (email, password_hash, nickname, created_at) VALUES ('old@test.dev', 'x', '옛 사용자', 0)").run()
        .lastInsertRowid,
    );
    db.prepare('INSERT INTO participants (league_id, user_id, cash, joined_at) VALUES (?, ?, 1234, 5)').run(leagueId, userId);

    migrate();
    migrate(); // idempotent
    expect(columns('participants')).toContain('left_at');
    expect(db.prepare('SELECT league_id, user_id, cash, joined_at, left_at FROM participants').all()).toEqual([
      { league_id: leagueId, user_id: userId, cash: 1234, joined_at: 5, left_at: null },
    ]);
  });

  it('rebuilds a pre-통합 leagues table to allow market ALL, keeping rows and foreign keys (twice: idempotent)', () => {
    resetDb();
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE leagues');
    db.exec(OLD_LEAGUES_DDL);
    db.pragma('foreign_keys = ON');
    db.exec('ALTER TABLE orders DROP COLUMN ref_fx');
    db.exec('ALTER TABLE orders DROP COLUMN fx_rate');
    db.exec('ALTER TABLE holdings DROP COLUMN avg_fx');
    expect(columns('leagues')).not.toContain('fx_spread');

    const leagueId = Number(
      db
        .prepare(
          `INSERT INTO leagues (name, type, market, currency, status, start_at, end_at, start_cash, decision_interval_min,
                                max_orders_per_day, fee_rate, tax_rate, invite_code, created_at)
           VALUES ('옛 리그', '1w', 'US', 'USD', 'active', 10, 20, 10000, 60, 10, 0.001, 0, 'ABC234', 5)`,
        )
        .run().lastInsertRowid,
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO leagues (name, type, market, currency, status, start_at, end_at, start_cash, decision_interval_min,
                                max_orders_per_day, fee_rate, tax_rate, created_at)
           VALUES ('통합', '1w', 'ALL', 'KRW', 'active', 0, 1, 1, 60, 10, 0, 0, 0)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    const userId = Number(
      db.prepare("INSERT INTO users (email, password_hash, nickname, created_at) VALUES ('old@test.dev', 'x', '옛', 0)").run()
        .lastInsertRowid,
    );
    const pid = Number(
      db.prepare('INSERT INTO participants (league_id, user_id, cash, joined_at) VALUES (?, ?, 9000, 5)').run(leagueId, userId)
        .lastInsertRowid,
    );
    db.prepare('INSERT INTO holdings (participant_id, symbol, quantity, avg_price) VALUES (?, ?, 3, 190)').run(pid, 'AAPL');
    db.prepare(
      `INSERT INTO orders (participant_id, symbol, side, type, quantity, ref_price, status, fill_price, fee, tax, source, trade_date, created_at)
       VALUES (?, 'AAPL', 'BUY', 'MARKET', 3, 190, 'filled', 190, 0.57, 0, 'user', '2026-10-19', 6)`,
    ).run(pid);

    migrate();
    migrate();

    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leagues'").pluck().get() as string;
    expect(ddl).toContain("'ALL'");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'leagues_new%'").all()).toEqual([]);
    expect(columns('leagues')).toContain('fx_spread');
    expect(db.prepare('SELECT id, name, market, invite_code, fx_spread, created_at FROM leagues').all()).toEqual([
      { id: leagueId, name: '옛 리그', market: 'US', invite_code: 'ABC234', fx_spread: 0, created_at: 5 },
    ]);
    expect(db.prepare('SELECT league_id, cash FROM participants').all()).toEqual([{ league_id: leagueId, cash: 9000 }]);
    expect(db.prepare('SELECT symbol, quantity, avg_fx FROM holdings').all()).toEqual([{ symbol: 'AAPL', quantity: 3, avg_fx: 1 }]);
    expect(db.prepare('SELECT status, fee, ref_fx, fx_rate FROM orders').all()).toEqual([
      { status: 'filled', fee: 0.57, ref_fx: null, fx_rate: null },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // participants.league_id still references leagues(id).
    expect(() => db.prepare('INSERT INTO participants (league_id, user_id, cash, joined_at) VALUES (999, ?, 1, 1)').run(userId)).toThrow(
      /FOREIGN KEY/,
    );
    db.prepare(
      `INSERT INTO leagues (name, type, market, currency, status, start_at, end_at, start_cash, decision_interval_min,
                            max_orders_per_day, fee_rate, tax_rate, fx_spread, created_at)
       VALUES ('통합 1주 리그 #1', '1w', 'ALL', 'KRW', 'recruiting', 0, 1, 10000000, 120, 15, 0.00015, 0.002, 0.001, 0)`,
    ).run();
    expect(db.prepare("SELECT COUNT(*) FROM leagues WHERE market = 'ALL'").pluck().get()).toBe(1);
  });

  it('checks only foreign keys to leagues when rebuilding: an unrelated orphan does not block it, an orphan participant does', () => {
    const oldDb = () => {
      resetDb();
      db.pragma('foreign_keys = OFF');
      db.exec('DROP TABLE leagues');
      db.exec(OLD_LEAGUES_DDL);
      const leagueId = Number(
        db
          .prepare(
            `INSERT INTO leagues (name, type, market, currency, status, start_at, end_at, start_cash, decision_interval_min,
                                  max_orders_per_day, fee_rate, tax_rate, created_at)
             VALUES ('옛 리그', '1w', 'KR', 'KRW', 'active', 0, 1, 10000000, 60, 10, 0.00015, 0.002, 0)`,
          )
          .run().lastInsertRowid,
      );
      // Unrelated orphans: a holding of a deleted participant, a participant of a deleted user.
      db.prepare("INSERT INTO holdings (participant_id, symbol, quantity, avg_price) VALUES (777, '005930', 1, 1)").run();
      db.prepare('INSERT INTO participants (league_id, user_id, cash, joined_at) VALUES (?, 888, 1, 1)').run(leagueId);
      db.pragma('foreign_keys = ON');
      return leagueId;
    };
    const ddl = () => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leagues'").pluck().get() as string;

    const leagueId = oldDb();
    migrate();
    expect(ddl()).toContain("'ALL'");
    expect(db.prepare('SELECT id FROM leagues').pluck().all()).toEqual([leagueId]);

    oldDb();
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO decision_logs (agent_id, participant_id, league_id, ts, status, latency_ms) VALUES (1, 1, 999, 0, 'ok', 0)").run();
    db.pragma('foreign_keys = ON');
    expect(() => migrate()).toThrow(/foreign key check failed after rebuilding leagues \(1\)/);
    expect(ddl()).not.toContain("'ALL'"); // rolled back
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('adds snapshots.fx_rate to an older database, keeping rows', () => {
    resetDb();
    db.exec('ALTER TABLE snapshots DROP COLUMN fx_rate');
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO snapshots (participant_id, ts, equity, return_rate) VALUES (1, 5, 100, 0)').run();
    db.pragma('foreign_keys = ON');
    migrate();
    migrate();
    expect(db.prepare('SELECT participant_id, ts, equity, fx_rate FROM snapshots').all()).toEqual([
      { participant_id: 1, ts: 5, equity: 100, fx_rate: null },
    ]);
  });

  it('refuses to rebuild a leagues table whose DDL it does not recognize', () => {
    resetDb();
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE leagues');
    db.exec(OLD_LEAGUES_DDL.replace("('KR','US')", "('KR','US','JP')"));
    db.pragma('foreign_keys = ON');
    expect(() => migrate()).toThrow(/unexpected leagues DDL/);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

/** leagues as created before 통합 leagues (schema.sql of 2026-10-30). */
const OLD_LEAGUES_DDL = `CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('3d','1w','1m','custom')),
  market TEXT NOT NULL CHECK (market IN ('KR','US')),
  currency TEXT NOT NULL CHECK (currency IN ('KRW','USD')),
  status TEXT NOT NULL CHECK (status IN ('recruiting','active','finished')),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  start_cash REAL NOT NULL,
  decision_interval_min INTEGER NOT NULL,
  max_orders_per_day INTEGER NOT NULL,
  fee_rate REAL NOT NULL,
  tax_rate REAL NOT NULL,           -- applied to SELL amount
  max_position_pct REAL NOT NULL DEFAULT 0.4,
  is_public INTEGER NOT NULL DEFAULT 1,
  invite_code TEXT,
  owner_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);`;
