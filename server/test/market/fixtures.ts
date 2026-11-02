import { readFileSync } from 'node:fs';

/** Loads server/test/fixtures/<name> as parsed JSON (a fresh copy per call). */
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
