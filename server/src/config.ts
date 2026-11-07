import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverRoot, '..');

// Tests must not pick up a developer's .env (e.g. SIM_ALWAYS_OPEN would break calendar tests).
// .env overrides the shell so tool-set variables (e.g. CLAUDE_EFFORT exported by Claude Code)
// do not silently change agent behaviour. server/.env wins over the root .env on duplicates.
if (!process.env.VITEST) {
  dotenv.config({
    path: [path.join(repoRoot, '.env'), path.join(serverRoot, '.env')],
    override: true,
    quiet: true,
  });
  // ENV_OVERLAY (path relative to the repo root, e.g. `.env.practice`) is loaded last and wins
  // over .env, so `npm run practice` can swap in sim prices and a separate DATA_DIR.
  const overlay = process.env.ENV_OVERLAY?.trim();
  if (overlay) {
    const overlayPath = path.resolve(repoRoot, overlay);
    const result = dotenv.config({ path: overlayPath, override: true, quiet: true });
    if (result.error) throw new Error(`ENV_OVERLAY file could not be loaded: ${overlayPath}`);
  }
}

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());
const bool = (fallback: boolean) =>
  z.preprocess(
    (v) => emptyToUndefined(typeof v === 'string' ? v.trim().toLowerCase() : v),
    z
      .enum(['true', 'false', '1', '0', 'yes', 'no'])
      .optional()
      .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1' || v === 'yes')),
  );
/**
 * Fastify `trustProxy`: true/false, or addresses/subnets to trust (e.g. `loopback`).
 * `true` trusts every hop, so a client-sent X-Forwarded-For picks the IP rate limits key on;
 * behind one local proxy (a tunnel) use `loopback` so only that proxy's appended IP counts.
 */
const trustProxy = z.preprocess(
  (v) => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : v;
    if (s === undefined || s === '' || s === 'false' || s === '0' || s === 'no') return false;
    if (s === 'true' || s === '1' || s === 'yes') return true;
    return s;
  },
  z.union([z.boolean(), z.string().regex(/^(?!\d+$)[a-z0-9.:/,\s]+$/, 'true/false or trusted addresses (e.g. loopback); hop counts are not supported')]),
);
/**
 * 입장코드 comparison form: NFKC (full-width letters and dashes become ASCII), then spaces and
 * dashes dropped and upper-cased, so `k7qm 4xpa` matches `K7QM-4XPA`.
 */
export function normalizeSignupCode(code: string): string {
  return code.normalize('NFKC').replace(/[\s\-‐-―−]+/g, '').toUpperCase();
}
const int = (fallback: number, min: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).default(fallback));

const EnvSchema = z.object({
  PORT: int(8787, 1),
  JWT_SECRET: optionalString,
  ADMIN_EMAILS: z.preprocess(emptyToUndefined, z.string().optional()),
  PRICE_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['yahoo', 'kis', 'sim']).default('yahoo')),
  SIM_ALWAYS_OPEN: bool(false),
  COLLECT_INTERVAL_SEC: int(60, 5),
  KIS_APP_KEY: optionalString,
  KIS_APP_SECRET: optionalString,
  KIS_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default('https://openapi.koreainvestment.com:9443')),
  ANTHROPIC_API_KEY: optionalString,
  CLAUDE_MODEL: z.preprocess(emptyToUndefined, z.string().default('claude-opus-5-5')),
  CLAUDE_EFFORT: z.preprocess(emptyToUndefined, z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low')),
  OLLAMA_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  OLLAMA_MODEL: z.preprocess(emptyToUndefined, z.string().default('qwen3:8b')),
  AGENT_TIMEOUT_SEC: int(60, 1),
  COOKIE_SECURE: bool(process.env.NODE_ENV === 'production'),
  TRUST_PROXY: trustProxy,
  SIGNUP_CODE: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .refine((s) => normalizeSignupCode(s).length >= 8, 'needs at least 8 characters besides spaces and hyphens (a short code can be guessed)')
      .optional(),
  ),
  DATA_DIR: optionalString,
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}
const env = parsed.data;

let jwtSecret = env.JWT_SECRET;
if (!jwtSecret) {
  jwtSecret = randomBytes(32).toString('hex');
  if (!process.env.VITEST) {
    console.warn('[config] JWT_SECRET is not set; using a random secret. Sessions will not survive a restart.');
  }
}

export type PriceProviderName = 'yahoo' | 'kis' | 'sim';
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Config {
  port: number;
  jwtSecret: string;
  adminEmails: string[];
  priceProvider: PriceProviderName;
  simAlwaysOpen: boolean;
  collectIntervalSec: number;
  kisAppKey: string | undefined;
  kisAppSecret: string | undefined;
  kisBaseUrl: string;
  anthropicApiKey: string | undefined;
  claudeModel: string;
  claudeEffort: ClaudeEffort;
  ollamaBaseUrl: string | undefined;
  ollamaModel: string;
  agentTimeoutSec: number;
  /** Marks the session cookie Secure; set when the app is served over HTTPS. */
  cookieSecure: boolean;
  /** Fastify trustProxy (behind a reverse proxy), so rate limits see the client IP. */
  trustProxy: boolean | string;
  /** When set, registering needs this code (compared via normalizeSignupCode); logins are unaffected. */
  signupCode: string | undefined;
  /** Absolute path of the data directory (SQLite file, KIS token cache); server/data unless DATA_DIR is set. */
  dataDir: string;
  /** Absolute path of web/dist, served in production. */
  webDistDir: string;
}

// Intentionally mutable so tests can flip flags such as simAlwaysOpen.
export const config: Config = {
  port: env.PORT,
  jwtSecret,
  adminEmails: (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  priceProvider: env.PRICE_PROVIDER,
  simAlwaysOpen: env.SIM_ALWAYS_OPEN,
  collectIntervalSec: env.COLLECT_INTERVAL_SEC,
  kisAppKey: env.KIS_APP_KEY,
  kisAppSecret: env.KIS_APP_SECRET,
  kisBaseUrl: env.KIS_BASE_URL.replace(/\/+$/, ''),
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  claudeModel: env.CLAUDE_MODEL,
  claudeEffort: env.CLAUDE_EFFORT,
  ollamaBaseUrl: env.OLLAMA_BASE_URL?.replace(/\/+$/, ''),
  ollamaModel: env.OLLAMA_MODEL,
  agentTimeoutSec: env.AGENT_TIMEOUT_SEC,
  cookieSecure: env.COOKIE_SECURE,
  trustProxy: env.TRUST_PROXY,
  signupCode: env.SIGNUP_CODE,
  // Relative DATA_DIR values resolve against the repo root, so `npm run dev` and `npm start` agree.
  dataDir: env.DATA_DIR ? path.resolve(repoRoot, env.DATA_DIR) : path.join(serverRoot, 'data'),
  webDistDir: path.join(repoRoot, 'web', 'dist'),
};
