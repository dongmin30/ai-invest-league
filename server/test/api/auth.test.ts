import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../../shared/api-types';
import { config } from '../../src/config';
import { db } from '../../src/db/db';
import { HOUR, KR_OPEN, resetEngineState, restoreEngineState } from '../engine/helpers';
import { expectApiError, register, sessionCookie, testApp } from './helpers';

let app: FastifyInstance;
const adminEmails = config.adminEmails;

beforeEach(async () => {
  resetEngineState(KR_OPEN + HOUR);
  app = await testApp();
});

afterEach(async () => {
  await app.close();
  config.adminEmails = adminEmails;
  restoreEngineState();
});

describe('auth', () => {
  it('serves /health without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, provider: expect.stringMatching(/^(yahoo|kis|sim)$/), time: KR_OPEN + HOUR });
  });

  it('registers, sets an httpOnly lax cookie, and resolves /auth/me from it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: '  Alice@Example.com ', password: 'password123', nickname: ' 앨리스 ' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { user } = res.json<{ user: User }>();
    expect(user).toMatchObject({ email: 'alice@example.com', nickname: '앨리스', role: 'admin', created_at: KR_OPEN + HOUR });
    expect(user).not.toHaveProperty('password_hash');

    const cookie = res.cookies.find((c) => c.name === 'token')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 3600 });
    expect(cookie.secure).toBeFalsy();
    const claims = app.jwt.decode<{ uid: number; iat: number; exp: number }>(cookie.value)!;
    expect(claims.uid).toBe(user.id);
    expect(claims.exp - claims.iat).toBe(7 * 24 * 3600);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { token: cookie.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: User }>().user).toEqual(user);

    const hash = db.prepare('SELECT password_hash FROM users WHERE id = ?').pluck().get(user.id) as string;
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
  });

  it('marks the cookie Secure when COOKIE_SECURE is on', async () => {
    const secure = config.cookieSecure;
    config.cookieSecure = true;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'secure@example.com', password: 'password123', nickname: '보안' },
      });
      expect(res.cookies.find((c) => c.name === 'token')!.secure).toBe(true);
    } finally {
      config.cookieSecure = secure;
    }
  });

  it('sends security headers on API responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('makes the first user admin only when ADMIN_EMAILS is empty', async () => {
    config.adminEmails = [];
    const first = await register(app, 'first@example.com');
    const second = await register(app, 'second@example.com');
    expect([first.user.role, second.user.role]).toEqual(['admin', 'user']);
  });

  it('with ADMIN_EMAILS set, promotes only those users, never the first one', async () => {
    config.adminEmails = ['boss@example.com'];
    const first = await register(app, 'first@example.com');
    const second = await register(app, 'second@example.com');
    const boss = await register(app, 'boss@example.com');
    expect([first.user.role, second.user.role, boss.user.role]).toEqual(['user', 'user', 'admin']);

    // A user added to ADMIN_EMAILS later is promoted on the next request.
    config.adminEmails = ['boss@example.com', 'second@example.com'];
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: second.cookies });
    expect(me.json<{ user: User }>().user.role).toBe('admin');
  });

  it('demotes admins missing from ADMIN_EMAILS once the list is set, including the bootstrap admin', async () => {
    config.adminEmails = [];
    const stranger = await register(app, 'stranger@example.com');
    expect(stranger.user.role).toBe('admin');
    const role = async (session: typeof stranger) =>
      (await app.inject({ method: 'GET', url: '/api/auth/me', cookies: session.cookies })).json<{ user: User }>().user.role;

    config.adminEmails = ['me@example.com'];
    expect(await role(stranger)).toBe('user');
    const run = await app.inject({ method: 'POST', url: '/api/admin/collect', cookies: stranger.cookies });
    expectApiError(run, 403, 'forbidden');
    const me = await register(app, 'me@example.com');
    expect(me.user.role).toBe('admin');

    // Removing an email from the list revokes the role; emptying the list keeps stored roles.
    config.adminEmails = ['other@example.com'];
    expect(await role(me)).toBe('user');
    config.adminEmails = ['me@example.com'];
    expect(await role(me)).toBe('admin');
    config.adminEmails = [];
    expect([await role(me), await role(stranger)]).toEqual(['admin', 'user']);
  });

  it('returns 401 without a cookie or with a forged one', async () => {
    expectApiError(await app.inject({ method: 'GET', url: '/api/auth/me' }), 401, 'unauthorized');
    expectApiError(
      await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { token: 'not-a-jwt' } }),
      401,
      'unauthorized',
    );
    const forged = app.jwt.sign({ uid: 999 });
    expectApiError(await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { token: forged } }), 401, 'unauthorized');
  });

  it('rejects a duplicate email regardless of case', async () => {
    await register(app, 'dup@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'DUP@example.com', password: 'password123', nickname: '중복' },
    });
    expectApiError(res, 409, 'email_taken');
  });

  it('validates the register body with Korean messages', async () => {
    const short = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', password: 'short', nickname: '닉네임' },
    });
    expect(expectApiError(short, 400, 'validation').message).toBe('비밀번호는 8자 이상이어야 합니다.');

    const badEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'nope', password: 'password123', nickname: '닉네임' },
    });
    expect(expectApiError(badEmail, 400, 'validation').message).toBe('이메일 형식이 올바르지 않습니다.');

    const nick = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'b@example.com', password: 'password123', nickname: 'x' },
    });
    expect(expectApiError(nick, 400, 'validation').message).toBe('닉네임은 2~20자여야 합니다.');

    expectApiError(await app.inject({ method: 'POST', url: '/api/auth/register' }), 400, 'validation');
  });

  it('logs in with the right password only, then logs out', async () => {
    const { user } = await register(app, 'login@example.com', '로그인', 'correct-horse');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'login@example.com', password: 'wrong-horse' },
    });
    expectApiError(wrong, 401, 'invalid_credentials');
    expect(wrong.cookies).toHaveLength(0);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@example.com', password: 'correct-horse' },
    });
    expectApiError(unknown, 401, 'invalid_credentials');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'LOGIN@example.com', password: 'correct-horse' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ user: User }>().user).toEqual(user);
    const token = sessionCookie(ok);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { token } });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    const cleared = out.cookies.find((c) => c.name === 'token')!;
    expect(cleared.value).toBe('');
    expect(cleared.expires!.getTime()).toBeLessThan(Date.now());
  });

  it('rate-limits auth attempts to 10 per minute per IP', async () => {
    const attempt = () =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@example.com', password: 'whatever1' } });
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
    expectApiError(await attempt(), 429, 'rate_limited');
  });

  it('behind a trusted local proxy, keys rate limits on the proxy-appended IP, not a spoofed X-Forwarded-For', async () => {
    const trustProxy = config.trustProxy;
    config.trustProxy = 'loopback';
    try {
      await app.close();
      app = await testApp();
      // inject comes from 127.0.0.1 (the tunnel); the last X-Forwarded-For entry is what the proxy saw.
      const attempt = (spoofed: string, client: string) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': `${spoofed}, ${client}` },
          payload: { email: 'x@example.com', password: 'whatever1' },
        });
      for (let i = 0; i < 10; i++) expect((await attempt(`10.0.0.${i}`, '203.0.113.7')).statusCode).toBe(401);
      expectApiError(await attempt('10.0.0.99', '203.0.113.7'), 429, 'rate_limited');
      // A different real client still has its own budget.
      expect((await attempt('10.0.0.1', '198.51.100.2')).statusCode).toBe(401);
    } finally {
      config.trustProxy = trustProxy;
    }
  });

  it('answers unknown API routes with a JSON 404', async () => {
    expectApiError(await app.inject({ method: 'GET', url: '/api/nope' }), 404, 'not_found');
    expectApiError(await app.inject({ method: 'POST', url: '/api/leagues/1/nope' }), 404, 'not_found');
  });

  it('answers malformed JSON with a 400 ApiError', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expectApiError(res, 400, 'bad_request');
  });
});
