import { beforeEach, describe, expect, it } from 'vitest';
import { db, migrate, resetDb, tx } from '../../src/db/db';

const TABLES = [
  'users',
  'agents',
  'leagues',
  'participants',
  'holdings',
  'orders',
  'quotes',
  'daily_bars',
  'snapshots',
  'decision_logs',
];

const tableNames = () =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[];
const userCount = () => db.prepare('SELECT COUNT(*) FROM users').pluck().get();
const insertUser = (email: string) =>
  db
    .prepare("INSERT INTO users (email, password_hash, nickname, created_at) VALUES (?, 'x', 'n', 0)")
    .run(email);

describe('db', () => {
  beforeEach(() => {
    resetDb();
  });

  it('migrate creates every table and is idempotent', () => {
    migrate();
    migrate();
    expect(tableNames()).toEqual(expect.arrayContaining(TABLES));
  });

  it('enforces foreign keys', () => {
    expect(() =>
      db
        .prepare('INSERT INTO holdings (participant_id, symbol, quantity, avg_price) VALUES (999, ?, 1, 1)')
        .run('AAPL'),
    ).toThrow(/FOREIGN KEY/);
  });

  it('tx rolls back on error and returns the result on success', () => {
    expect(() =>
      tx(() => {
        insertUser('a@example.com');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(userCount()).toBe(0);
    expect(tx(() => insertUser('b@example.com').changes)).toBe(1);
  });

  it('resetDb clears rows and keeps prepared statements usable', () => {
    const count = db.prepare('SELECT COUNT(*) FROM users').pluck();
    insertUser('a@example.com');
    expect(count.get()).toBe(1);
    resetDb();
    expect(count.get()).toBe(0);
  });
});
