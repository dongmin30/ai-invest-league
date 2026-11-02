import type { User } from '../../../shared/api-types';
import { config } from '../config';
import { tx } from '../db/db';
import { sql } from '../engine/store';
import { now } from '../lib/time';

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  nickname: string;
  role: User['role'];
  created_at: number;
}

export interface UserWithHash {
  user: User;
  passwordHash: string;
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, nickname: row.nickname, role: row.role, created_at: row.created_at };
}

/**
 * Once ADMIN_EMAILS is set it is authoritative: listed users are promoted and everyone else,
 * including a bootstrap admin from when the list was empty, is demoted. An empty list leaves
 * stored roles alone.
 */
function withConfiguredRole(row: UserRow): UserRow {
  if (config.adminEmails.length === 0) return row;
  const role: User['role'] = config.adminEmails.includes(row.email) ? 'admin' : 'user';
  if (row.role === role) return row;
  sql('UPDATE users SET role = ? WHERE id = ?').run(role, row.id);
  return { ...row, role };
}

export function getUserById(id: number): User | null {
  const row = sql('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toUser(withConfiguredRole(row)) : null;
}

/** `email` must already be normalized (trimmed, lower case). */
export function findUserByEmail(email: string): UserWithHash | null {
  const row = sql('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  if (!row) return null;
  return { user: toUser(withConfiguredRole(row)), passwordHash: row.password_hash };
}

/**
 * Inserts a user; ADMIN_EMAILS members become admins. When ADMIN_EMAILS is empty the first
 * user is promoted instead, so a fresh install has an admin. Returns null if the email is taken.
 */
export function createUser(email: string, passwordHash: string, nickname: string): User | null {
  return tx(() => {
    if (sql('SELECT 1 FROM users WHERE email = ?').get(email)) return null;
    const isFirst = (sql('SELECT COUNT(*) FROM users').pluck().get() as number) === 0;
    const bootstrapAdmin = isFirst && config.adminEmails.length === 0;
    if (bootstrapAdmin && !process.env.VITEST) {
      console.warn(`[auth] ADMIN_EMAILS is empty; the first registered user (${email}) became admin.`);
    }
    const role: User['role'] = bootstrapAdmin || config.adminEmails.includes(email) ? 'admin' : 'user';
    const id = Number(
      sql('INSERT INTO users (email, password_hash, nickname, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
        email,
        passwordHash,
        nickname,
        role,
        now(),
      ).lastInsertRowid,
    );
    return getUserById(id);
  });
}
