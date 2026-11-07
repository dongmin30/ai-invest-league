import { createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SignupOptions, User } from '../../../shared/api-types';
import { config, normalizeSignupCode } from '../config';
import { ApiHttpError, forbidden, unauthorized } from './errors';
import { createUser, findUserByEmail, getUserById } from './users';

export const SESSION_COOKIE = 'token';
const SESSION_SEC = 7 * 24 * 60 * 60;
const BCRYPT_COST = 10;
/** Per IP and per route. */
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { uid: number };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: User | null;
  }
}

const Email = z
  .string('이메일을 입력해 주세요.')
  .trim()
  .toLowerCase()
  .pipe(z.email('이메일 형식이 올바르지 않습니다.').max(254, '이메일이 너무 깁니다.'));

const RegisterBody = z.object({
  email: Email,
  // bcrypt only uses the first 72 bytes.
  password: z.string('비밀번호를 입력해 주세요.').min(8, '비밀번호는 8자 이상이어야 합니다.').max(72, '비밀번호는 72자 이하여야 합니다.'),
  nickname: z
    .string('닉네임을 입력해 주세요.')
    .trim()
    .min(2, '닉네임은 2~20자여야 합니다.')
    .max(20, '닉네임은 2~20자여야 합니다.'),
  signup_code: z.string().max(100).optional(),
});

const LoginBody = z.object({
  email: Email,
  password: z.string('비밀번호를 입력해 주세요.').min(1, '비밀번호를 입력해 주세요.').max(200),
});

function cookieOptions(): CookieSerializeOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: SESSION_SEC,
  };
}

/** True when no signup code is configured or `given` matches it (constant-time on digests). */
function signupCodeMatches(given: string | undefined): boolean {
  const expected = config.signupCode;
  if (!expected) return true;
  if (given === undefined) return false;
  const digest = (s: string) => createHash('sha256').update(normalizeSignupCode(s)).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

let dummyHash: string | undefined;
/** Compared against when the email is unknown, so both failure paths take about as long. */
function timingDummy(): string {
  dummyHash ??= bcrypt.hashSync('timing-equalizer', BCRYPT_COST);
  return dummyHash;
}

function startSession(app: FastifyInstance, reply: FastifyReply, user: User): void {
  const token = app.jwt.sign({ uid: user.id }, { expiresIn: SESSION_SEC });
  reply.setCookie(SESSION_COOKIE, token, cookieOptions());
}

/** The signed-in user for this request, or null (missing, invalid or expired cookie, deleted user). */
export function readSession(app: FastifyInstance, req: FastifyRequest): User | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  try {
    const { uid } = app.jwt.verify<{ uid: number }>(token);
    return typeof uid === 'number' ? getUserById(uid) : null;
  } catch {
    return null;
  }
}

export function requireUser(req: FastifyRequest): User {
  if (!req.authUser) throw unauthorized();
  return req.authUser;
}

export function requireAdmin(req: FastifyRequest): User {
  const user = requireUser(req);
  if (user.role !== 'admin') throw forbidden('관리자만 사용할 수 있습니다.');
  return user;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const limited = { config: { rateLimit: AUTH_RATE_LIMIT } };

  app.post('/auth/register', limited, async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    // Checked before the email lookup, so outsiders cannot probe which emails are registered.
    if (!signupCodeMatches(body.signup_code)) {
      throw new ApiHttpError(403, 'invalid_signup_code', '입장코드가 올바르지 않습니다. 초대한 사람에게 코드를 확인해 주세요.');
    }
    const hash = await bcrypt.hash(body.password, BCRYPT_COST);
    const user = createUser(body.email, hash, body.nickname);
    if (!user) throw new ApiHttpError(409, 'email_taken', '이미 가입된 이메일입니다.');
    startSession(app, reply, user);
    return { user };
  });

  app.get('/auth/signup-options', async (): Promise<SignupOptions> => ({
    signup_code_required: Boolean(config.signupCode),
  }));

  app.post('/auth/login', limited, async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const found = findUserByEmail(body.email);
    const ok = await bcrypt.compare(body.password, found?.passwordHash ?? timingDummy());
    if (!found || !ok) throw new ApiHttpError(401, 'invalid_credentials', '이메일 또는 비밀번호가 올바르지 않습니다.');
    startSession(app, reply, found.user);
    return { user: found.user };
  });

  // Works without a valid session so a stale cookie can always be cleared.
  app.post('/auth/logout', limited, async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => ({ user: requireUser(req) }));
}
