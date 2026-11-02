import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { ApiError, User } from '../../../shared/api-types';
import { buildApp } from '../../src/api/app';
import type { Collector } from '../../src/market/collector';

/** A web dist directory that does not exist, so tests do not depend on a built web app. */
export const NO_WEB = path.join(import.meta.dirname, '__no_web_dist__');

export function testApp(collector?: Collector): Promise<FastifyInstance> {
  return buildApp({ webDistDir: NO_WEB, collector });
}

export interface Session {
  user: User;
  cookies: { token: string };
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === 'token');
  if (!cookie) throw new Error(`no session cookie in response ${res.statusCode}: ${res.body}`);
  return cookie.value;
}

export async function register(
  app: FastifyInstance,
  email: string,
  nickname = email.split('@')[0]!.slice(0, 20),
  password = 'password123',
): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password, nickname } });
  expect(res.statusCode, res.body).toBe(200);
  return { user: res.json<{ user: User }>().user, cookies: { token: sessionCookie(res) } };
}

export function expectApiError(res: LightMyRequestResponse, status: number, code: string): ApiError {
  expect(res.statusCode, res.body).toBe(status);
  const body = res.json<ApiError>();
  expect(body.error).toBe(code);
  expect(typeof body.message).toBe('string');
  expect(body.message.length).toBeGreaterThan(0);
  expect(body).not.toHaveProperty('stack');
  return body;
}
