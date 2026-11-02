import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setNow } from '../../src/lib/time';
import {
  createKisProvider,
  KisError,
  parseKisDomesticQuote,
  parseKisOverseasQuote,
  parseKisToken,
} from '../../src/market/providers/kis';
import type { PriceProvider } from '../../src/market/providers/types';
import { getSymbol } from '../../src/market/symbols';
import { fixture, jsonResponse } from './fixtures';

const samsung = getSymbol('005930')!;
const kakao = getSymbol('035720')!;
const apple = getSymbol('AAPL')!;
const jpm = getSymbol('JPM')!;
const T0 = Date.UTC(2026, 9, 19, 1, 0); // Mon 10:00 KST
const HOUR = 3_600_000;

describe('KIS parsers (hand-made fixtures)', () => {
  it('parses domestic inquire-price', () => {
    expect(parseKisDomesticQuote(fixture('kis-domestic-price-005930.json'), samsung, T0)).toEqual({
      symbol: '005930',
      market: 'KR',
      price: 215500,
      change_pct: 2.62,
      volume: 20296806,
      ts: T0,
      source: 'kis',
    });
  });

  it('keeps the sign of a falling domestic quote', () => {
    const q = parseKisDomesticQuote(fixture('kis-domestic-price-down.json'), kakao, T0);
    expect(q.price).toBe(31850);
    expect(q.change_pct).toBe(-2);
  });

  it('parses overseas price, with or without an explicit sign on rate', () => {
    const up = parseKisOverseasQuote(fixture('kis-overseas-price-AAPL.json'), apple, T0);
    expect(up).toEqual({
      symbol: 'AAPL',
      market: 'US',
      price: 343.46,
      change_pct: 0.43,
      volume: 59852690,
      ts: T0,
      source: 'kis',
    });
    // sign 5 (하락) with an unsigned rate is still a fall.
    expect(parseKisOverseasQuote(fixture('kis-overseas-price-JPM-down.json'), jpm, T0).change_pct).toBe(-1.25);
  });

  it('rejects empty prices and error envelopes', () => {
    expect(() => parseKisOverseasQuote(fixture('kis-overseas-price-empty.json'), apple, T0)).toThrow(KisError);
    try {
      parseKisDomesticQuote(fixture('kis-error-rate-limit.json'), samsung, T0);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(KisError);
      expect((err as KisError).code).toBe('EGW00201');
      expect((err as KisError).message).toBe('초당 거래건수를 초과하였습니다.');
    }
  });

  it('caps the token lifetime at 23 hours', () => {
    expect(parseKisToken(fixture('kis-token.json'), T0)).toEqual({
      access_token: fixture('kis-token.json').access_token,
      expires_at: T0 + 23 * HOUR,
    });
    expect(parseKisToken({ access_token: 'x', expires_in: 3600 }, T0).expires_at).toBe(T0 + HOUR - 5 * 60_000);
    expect(() => parseKisToken(fixture('kis-token-error.json'), T0)).toThrow(/1분당 1회/);
  });
});

describe('createKisProvider', () => {
  let dir: string;
  let tokenFile: string;
  let clock: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-test-'));
    tokenFile = path.join(dir, 'kis-token.json');
    clock = T0;
    setNow(() => clock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setNow(null);
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  interface Call {
    url: URL;
    init?: RequestInit;
  }

  /** Fake KIS server; `quote` decides the response of each price request. */
  function fakeKis(quote: (call: Call, n: number) => Response) {
    const calls: Call[] = [];
    let quoteCalls = 0;
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const call = { url: new URL(input), init };
      calls.push(call);
      if (call.url.pathname === '/oauth2/tokenP') {
        tokenCalls++;
        return jsonResponse({ ...fixture<object>('kis-token.json'), access_token: `token-${tokenCalls}` });
      }
      return quote(call, ++quoteCalls);
    });
    return { fetchImpl, calls, tokenCalls: () => tokenCalls };
  }

  const quoteResponse = (call: Call) =>
    call.url.pathname.includes('overseas')
      ? jsonResponse(fixture('kis-overseas-price-AAPL.json'))
      : jsonResponse(fixture('kis-domestic-price-005930.json'));

  const make = (fetchImpl: typeof fetch | ((i: string, r?: RequestInit) => Promise<Response>), key = 'app-key') =>
    createKisProvider({
      appKey: key,
      appSecret: 'app-secret',
      baseUrl: 'https://kis.example:9443/',
      fetchImpl,
      tokenFile,
      retryDelayMs: 1,
      dailyBars: { name: 'yahoo', fetchQuotes: async () => [], fetchDailyBars: async () => [] } as PriceProvider,
    });

  it('issues one token for a batch and sends the documented headers and params', async () => {
    const kis = fakeKis(quoteResponse);
    const quotes = await make(kis.fetchImpl).fetchQuotes([samsung, apple, jpm]);

    expect(quotes.map((q) => q.symbol)).toEqual(['005930', 'AAPL', 'JPM']);
    expect(kis.tokenCalls()).toBe(1);

    const tokenCall = kis.calls.find((c) => c.url.pathname === '/oauth2/tokenP')!;
    expect(tokenCall.init?.method).toBe('POST');
    expect(JSON.parse(tokenCall.init?.body as string)).toEqual({
      grant_type: 'client_credentials',
      appkey: 'app-key',
      appsecret: 'app-secret',
    });

    const domestic = kis.calls.find((c) => c.url.pathname.includes('domestic'))!;
    expect(domestic.url.pathname).toBe('/uapi/domestic-stock/v1/quotations/inquire-price');
    expect(Object.fromEntries(domestic.url.searchParams)).toEqual({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' });
    expect(domestic.init?.headers).toMatchObject({
      authorization: 'Bearer token-1',
      appkey: 'app-key',
      appsecret: 'app-secret',
      tr_id: 'FHKST01010100',
      custtype: 'P',
    });

    const overseas = kis.calls.filter((c) => c.url.pathname === '/uapi/overseas-price/v1/quotations/price');
    expect(overseas.map((c) => Object.fromEntries(c.url.searchParams))).toEqual([
      { AUTH: '', EXCD: 'NAS', SYMB: 'AAPL' },
      { AUTH: '', EXCD: 'NYS', SYMB: 'JPM' },
    ]);
    expect(overseas[0]!.init?.headers).toMatchObject({ tr_id: 'HHDFS00000300' });
  });

  it('reuses the token from kis-token.json across instances until the app key changes', async () => {
    const first = fakeKis(quoteResponse);
    await make(first.fetchImpl).fetchQuotes([samsung]);
    expect(JSON.parse(fs.readFileSync(tokenFile, 'utf8'))).toMatchObject({
      access_token: 'token-1',
      expires_at: T0 + 23 * HOUR,
    });

    const second = fakeKis(quoteResponse);
    await make(second.fetchImpl).fetchQuotes([samsung]);
    expect(second.tokenCalls()).toBe(0);

    const otherKey = fakeKis(quoteResponse);
    await make(otherKey.fetchImpl, 'other-key').fetchQuotes([samsung]);
    expect(otherKey.tokenCalls()).toBe(1);
  });

  it('renews the token after 23 hours', async () => {
    const kis = fakeKis(quoteResponse);
    const provider = make(kis.fetchImpl);
    await provider.fetchQuotes([samsung]);
    clock += 23 * HOUR;
    await provider.fetchQuotes([samsung]);
    expect(kis.tokenCalls()).toBe(2);
  });

  it('retries EGW00201 and HTTP 429 with backoff', async () => {
    const kis = fakeKis((call, n) => {
      if (n === 1) return jsonResponse(fixture('kis-error-rate-limit.json'), 500);
      if (n === 2) return jsonResponse({}, 429);
      return quoteResponse(call);
    });
    const quotes = await make(kis.fetchImpl).fetchQuotes([samsung]);
    expect(quotes).toHaveLength(1);
    expect(kis.calls.filter((c) => c.url.pathname.includes('domestic'))).toHaveLength(3);
  });

  it('gives up on a symbol after repeated rate-limit errors without failing the batch', async () => {
    const kis = fakeKis((call) =>
      call.url.searchParams.get('SYMB') === 'AAPL'
        ? jsonResponse(fixture('kis-error-rate-limit.json'), 500)
        : quoteResponse(call),
    );
    const quotes = await make(kis.fetchImpl).fetchQuotes([samsung, apple]);
    expect(quotes.map((q) => q.symbol)).toEqual(['005930']);
    expect(kis.calls.filter((c) => c.url.searchParams.get('SYMB') === 'AAPL')).toHaveLength(3);
  });

  it('re-issues an expired token at most once per minute', async () => {
    let expire = true;
    const kis = fakeKis((call) => {
      if (expire) return jsonResponse(fixture('kis-error-token-expired.json'), 500);
      return quoteResponse(call);
    });
    const provider = make(kis.fetchImpl);

    // Token rejected right after issuance: re-issuance within a minute is refused locally.
    expect(await provider.fetchQuotes([samsung])).toEqual([]);
    expect(kis.tokenCalls()).toBe(1);

    clock += 61_000;
    expire = false;
    const quotes = await provider.fetchQuotes([samsung]);
    expect(quotes).toHaveLength(1);
    expect(kis.tokenCalls()).toBe(2);
    expect(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).access_token).toBe('token-2');
  });
});
