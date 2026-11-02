import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config';

// Under Vitest (process.env.VITEST is set) the database is in-memory and migrated on load.
// Vitest runs each test file in its own module graph, so every test file starts from a
// fresh, empty schema; call resetDb() in beforeEach when individual tests need a clean slate.
const inMemory = Boolean(process.env.VITEST);

function open(): Database.Database {
  if (inMemory) return new Database(':memory:');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const conn = new Database(path.join(config.dataDir, 'app.db'));
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('busy_timeout = 5000');
  return conn;
}

export const db: Database.Database = open();
db.pragma('foreign_keys = ON');

const schemaSql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves existing tables
 * untouched, so each one is added with ALTER TABLE when an older database lacks it.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'participants', column: 'left_at', definition: 'INTEGER' },
  { table: 'leagues', column: 'fx_spread', definition: 'REAL NOT NULL DEFAULT 0' },
  { table: 'orders', column: 'ref_fx', definition: 'REAL' },
  { table: 'orders', column: 'fx_rate', definition: 'REAL' },
  { table: 'holdings', column: 'avg_fx', definition: 'REAL NOT NULL DEFAULT 1' },
  { table: 'snapshots', column: 'fx_rate', definition: 'REAL' },
];

const OLD_MARKET_CHECK = /CHECK\s*\(\s*market\s+IN\s*\(\s*'KR'\s*,\s*'US'\s*\)\s*\)/i;
const TABLE_NAME = /^(CREATE\s+TABLE\s+)(?:IF\s+NOT\s+EXISTS\s+)?(?:"leagues"|`leagues`|\[leagues\]|leagues)(?=\s*\()/i;

/**
 * Widens leagues.market's CHECK to ('KR','US','ALL') on databases created before 통합 leagues.
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt from its stored DDL (which
 * already carries every column added since): create leagues_new, copy, drop, rename. Foreign
 * keys are switched off around it (other tables reference leagues(id) by name, which stays
 * valid) and, before commit, every foreign key pointing at leagues is checked (only those: an
 * unrelated orphan elsewhere must not block the upgrade). Skipped when the DDL already allows 'ALL'.
 */
function widenLeagueMarketCheck(): void {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leagues'").pluck().get() as
    | string
    | undefined;
  if (!ddl || /'ALL'/.test(ddl)) return;
  if (!OLD_MARKET_CHECK.test(ddl) || !TABLE_NAME.test(ddl)) {
    throw new Error('migrate: unexpected leagues DDL, cannot widen the market CHECK constraint');
  }
  const newDdl = ddl.replace(OLD_MARKET_CHECK, "CHECK (market IN ('KR','US','ALL'))").replace(TABLE_NAME, '$1leagues_new');
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'leagues' AND sql IS NOT NULL")
    .pluck()
    .all() as string[];
  const columns = (db.prepare('PRAGMA table_info("leagues")').all() as { name: string }[])
    .map((c) => `"${c.name}"`)
    .join(', ');

  db.pragma('foreign_keys = OFF');
  try {
    tx(() => {
      db.exec(newDdl);
      db.exec(`INSERT INTO leagues_new (${columns}) SELECT ${columns} FROM leagues`);
      db.exec('DROP TABLE leagues');
      db.exec('ALTER TABLE leagues_new RENAME TO leagues');
      for (const sql of indexes) db.exec(sql);
      // Tables with a foreign key to leagues (participants, decision_logs, ...), found from the schema.
      const children = db
        .prepare(
          `SELECT DISTINCT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f
           WHERE m.type = 'table' AND lower(f."table") = 'leagues'`,
        )
        .pluck()
        .all() as string[];
      const problems = children.flatMap((name) =>
        (db.pragma(`foreign_key_check("${name}")`) as { parent: string }[]).filter((p) => p.parent.toLowerCase() === 'leagues'),
      );
      if (problems.length > 0) throw new Error(`migrate: foreign key check failed after rebuilding leagues (${problems.length})`);
    });
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Applies schema.sql, widens the leagues market CHECK, then adds missing columns.
 * Idempotent and keeps existing rows.
 */
export function migrate(): void {
  db.exec(schemaSql);
  widenLeagueMarketCheck();
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

if (inMemory) migrate();

/**
 * Runs fn inside a transaction and returns its result. Nested calls become savepoints,
 * so engine functions can call each other freely.
 */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn)();
}

/**
 * Drops every table and re-applies the schema. Test-only: refuses to touch the file DB.
 * The connection is kept, so prepared statements held by modules stay usable.
 */
export function resetDb(): void {
  if (!inMemory) throw new Error('resetDb() is only allowed on the in-memory test database');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .pluck()
    .all() as string[];
  db.pragma('foreign_keys = OFF');
  try {
    for (const name of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  migrate();
}
