// Korea Investment & Securities (KIS) Open API price provider.
// UNTESTED LIVE until KIS_APP_KEY / KIS_APP_SECRET are provided: request and response
// shapes follow the KIS developer docs and are covered only by hand-made fixture tests.
//
// - Token: POST /oauth2/tokenP, cached 23h in memory and in server/data/kis-token.json.
//   KIS allows one issuance per minute (EGW00133), so issuance is throttled locally too.
// - Quotes: one request per symbol, 15 req/s token bucket (KIS allows ~20 req/s per real-account
//   app key); EGW00201 (per-second limit) and HTTP 429 are retried. A full US refresh
//   (~160 symbols) therefore takes ~11 s, within the 60 s collect interval.
// - Overseas EXCD: NAS (Nasdaq), NYS (NYSE), AMS (NYSE Arca / Cboe-listed ETFs).
// - Daily bars are delegated to Yahoo (the KIS daily-chart endpoints add nothing for an MVP).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Quote } from '../../../../shared/api-types';
import { now } from '../../lib/time';
import type { SymbolInfo } from '../symbols';
import { backoffMs, createLimiter, createRateLimiter, errorMessage, sleep } from './http';
import type { FetchLike, PriceProvider } from './types';
import { createYahooProvider } from './yahoo';

const TOKEN_TTL_MS = 23 * 3_600_000;
const TOKEN_SAFETY_MS = 5 * 60_000;
const TOKEN_ISSUE_INTERVAL_MS = 60_000;
const REQUESTS_PER_SEC = 15;
const MAX_CONCURRENT = 4;
const MAX_RATE_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 10_000;

const TR_DOMESTIC_PRICE = 'FHKST01010100';
const TR_OVERSEAS_PRICE = 'HHDFS00000300';
const RATE_LIMIT_CODE = 'EGW00201';
const TOKEN_INVALID_CODES = new Set(['EGW00121', 'EGW00123']);
// KIS sign codes (prdy_vrss_sign / sign): 1 상한, 2 상승, 3 보합, 4 하한, 5 하락.
const DOWN_SIGNS = new Set(['4', '5']);

export class KisError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'KisError';
  }
}

export interface KisToken {
  access_token: string;
  /** Epoch ms after which the token must not be used. */
  expires_at: number;
}

interface KisBody {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
  output?: Record<string, string | undefined>;
}

/** Parses a KIS numeric string ("215500", "+0.43", " -1.25", "1,234"). */
function kisNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = v.replace(/[,\s+]/g, '');
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function signedRate(rate: number, sign: string | undefined): number {
  return sign !== undefined && DOWN_SIGNS.has(sign) ? -Math.abs(rate) : rate;
}

function okOutput(json: unknown): Record<string, string | undefined> {
  const body = json as KisBody | undefined;
  if (!body || body.rt_cd !== '0') {
    throw new KisError(body?.msg1?.trim() || 'KIS request failed', body?.msg_cd);
  }
  if (!body.output) throw new KisError('KIS response has no output', body.msg_cd);
  return body.output;
}

/** Parses `inquire-price` (FHKST01010100). The endpoint has no timestamp, so `ts` is the fetch time. */
export function parseKisDomesticQuote(json: unknown, info: SymbolInfo, ts: number): Quote {
  const out = okOutput(json);
  const price = kisNumber(out.stck_prpr);
  if (price === undefined || price <= 0) throw new KisError(`No price for ${info.symbol}`);
  return {
    symbol: info.symbol,
    market: info.market,
    price,
    change_pct: signedRate(kisNumber(out.prdy_ctrt) ?? 0, out.prdy_vrss_sign),
    volume: kisNumber(out.acml_vol) ?? 0,
    ts,
    source: 'kis',
  };
}

/** Parses overseas `price` (HHDFS00000300). `last` is empty when KIS has no price for the symbol. */
export function parseKisOverseasQuote(json: unknown, info: SymbolInfo, ts: number): Quote {
  const out = okOutput(json);
  const price = kisNumber(out.last);
  if (price === undefined || price <= 0) throw new KisError(`No price for ${info.symbol}`);
  return {
    symbol: info.symbol,
    market: info.market,
    price,
    change_pct: signedRate(kisNumber(out.rate) ?? 0, out.sign),
    volume: kisNumber(out.tvol) ?? 0,
    ts,
    source: 'kis',
  };
}

/** Parses the `/oauth2/tokenP` response. The token is kept for at most 23h. */
export function parseKisToken(json: unknown, issuedAt: number): KisToken {
  const body = json as
    | { access_token?: string; expires_in?: number; error_code?: string; error_description?: string }
    | undefined;
  if (!body?.access_token) {
    throw new KisError(body?.error_description ?? 'KIS token response has no access_token', body?.error_code);
  }
  const serverTtl = typeof body.expires_in === 'number' ? body.expires_in * 1000 - TOKEN_SAFETY_MS : TOKEN_TTL_MS;
  return { access_token: body.access_token, expires_at: issuedAt + Math.min(TOKEN_TTL_MS, serverTtl) };
}

export interface KisOptions {
  appKey: string;
  appSecret: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
  /** Token cache file; `null` keeps the token in memory only. */
  tokenFile?: string | null;
  retryDelayMs?: number;
  /** Source of daily bars; defaults to a Yahoo provider. */
  dailyBars?: PriceProvider;
}

interface TokenFile extends KisToken {
  /** Hash of the app key so a key change invalidates the cached token. */
  key_id: string;
}

export function createKisProvider(opts: KisOptions): PriceProvider {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const tokenFile = opts.tokenFile === undefined ? null : opts.tokenFile;
  const keyId = createHash('sha256').update(opts.appKey).digest('hex').slice(0, 16);
  const dailyBars = opts.dailyBars ?? createYahooProvider();
  const limit = createLimiter(MAX_CONCURRENT);
  const takeToken = createRateLimiter(REQUESTS_PER_SEC);

  let token: KisToken | null = null;
  let pendingToken: Promise<KisToken> | null = null;
  let lastIssueAt = -Infinity;

  const usable = (t: KisToken | null): t is KisToken => t !== null && t.expires_at > now() + 60_000;

  function readTokenFile(): KisToken | null {
    if (!tokenFile) return null;
    try {
      const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as Partial<TokenFile>;
      if (saved.key_id !== keyId || typeof saved.access_token !== 'string' || typeof saved.expires_at !== 'number') {
        return null;
      }
      return { access_token: saved.access_token, expires_at: saved.expires_at };
    } catch {
      return null;
    }
  }

  function writeTokenFile(t: KisToken): void {
    if (!tokenFile) return;
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      const data: TokenFile = { ...t, key_id: keyId };
      fs.writeFileSync(tokenFile, JSON.stringify(data), { mode: 0o600 });
    } catch (err) {
      console.warn(`[kis] could not write token cache: ${errorMessage(err)}`);
    }
  }

  async function issueToken(): Promise<KisToken> {
    const wait = lastIssueAt + TOKEN_ISSUE_INTERVAL_MS - now();
    if (wait > 0) throw new KisError(`KIS token issuance throttled; retry in ${Math.ceil(wait / 1000)}s`, 'EGW00133');
    lastIssueAt = now();
    const res = await fetchImpl(`${baseUrl}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: opts.appKey, appsecret: opts.appSecret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => undefined);
    const issued = parseKisToken(body, now());
    writeTokenFile(issued);
    return issued;
  }

  async function getToken(): Promise<KisToken> {
    if (usable(token)) return token;
    const fromFile = readTokenFile();
    if (usable(fromFile)) return (token = fromFile);
    // Concurrent callers share one issuance request.
    pendingToken ??= issueToken().finally(() => {
      pendingToken = null;
    });
    return (token = await pendingToken);
  }

  async function get(apiPath: string, trId: string, params: Record<string, string>): Promise<unknown> {
    const url = `${baseUrl}${apiPath}?${new URLSearchParams(params)}`;
    let tokenRefreshed = false;

    for (let attempt = 1; ; attempt++) {
      const { access_token } = await getToken();
      await takeToken();
      const res = await fetchImpl(url, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${access_token}`,
          appkey: opts.appKey,
          appsecret: opts.appSecret,
          tr_id: trId,
          custtype: 'P',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => undefined)) as KisBody | undefined;
      if (res.ok && body?.rt_cd === '0') return body;

      const code = body?.msg_cd;
      if ((res.status === 429 || code === RATE_LIMIT_CODE) && attempt <= MAX_RATE_RETRIES) {
        await sleep(backoffMs(attempt, retryDelayMs, res.headers.get('retry-after')));
        continue;
      }
      if ((res.status === 401 || (code !== undefined && TOKEN_INVALID_CODES.has(code))) && !tokenRefreshed) {
        tokenRefreshed = true;
        token = null;
        if (tokenFile) fs.rmSync(tokenFile, { force: true });
        continue;
      }
      throw new KisError(`${trId} HTTP ${res.status}: ${body?.msg1?.trim() || 'request failed'}`, code, res.status);
    }
  }

  async function fetchQuote(info: SymbolInfo): Promise<Quote> {
    if (info.market === 'KR') {
      const body = await get('/uapi/domestic-stock/v1/quotations/inquire-price', TR_DOMESTIC_PRICE, {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: info.symbol,
      });
      return parseKisDomesticQuote(body, info, now());
    }
    if (!info.kisExchange) throw new KisError(`${info.symbol} has no KIS exchange code`);
    const body = await get('/uapi/overseas-price/v1/quotations/price', TR_OVERSEAS_PRICE, {
      AUTH: '',
      EXCD: info.kisExchange,
      SYMB: info.symbol,
    });
    return parseKisOverseasQuote(body, info, now());
  }

  return {
    name: 'kis',

    async fetchQuotes(symbols) {
      const settled = await Promise.allSettled(symbols.map((info) => limit(() => fetchQuote(info))));
      const quotes: Quote[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') quotes.push(r.value);
        else console.warn(`[kis] quote ${symbols[i]!.symbol} failed: ${errorMessage(r.reason)}`);
      });
      return quotes;
    },

    fetchDailyBars(info, days) {
      return dailyBars.fetchDailyBars(info, days);
    },

    async fetchDailyBarsMany(symbols, days) {
      return dailyBars.fetchDailyBarsMany ? dailyBars.fetchDailyBarsMany(symbols, days) : new Map();
    },

    // USD/KRW comes from Yahoo like daily bars (the quotes-only KIS key has no FX endpoint here).
    async fetchFx() {
      if (!dailyBars.fetchFx) throw new Error('daily bars provider has no fetchFx');
      return dailyBars.fetchFx();
    },
  };
}
