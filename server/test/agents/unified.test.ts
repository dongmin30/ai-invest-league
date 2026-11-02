import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FxQuote } from '../../../shared/api-types';
import { buildPrompt } from '../../src/agents/prompt';
import {
  buildDecisionInput,
  CORE_CANDIDATES,
  MAX_CANDIDATES,
  runDecision,
  selectCandidates,
  setProviderResolver,
} from '../../src/agents/runner';
import { decideBaseline } from '../../src/agents/strategies/baseline';
import { decideMomentum } from '../../src/agents/strategies/momentum';
import type { CandidateRow, LLMProvider } from '../../src/agents/types';
import { getSymbol, isLeveraged, SYMBOLS, symbolsFor } from '../../src/market/symbols';
import { clockNow, HOUR, KR_OPEN, resetEngineState, restoreEngineState, setClock, setFxRate, US_OPEN } from '../engine/helpers';
import { agentLeague, candidate, feedMarket, holding, pureInput } from './fixtures';

// 통합 (ALL) leagues: candidates from both markets, KRW sizing, FX in the prompt.

const SATURDAY = Date.UTC(2026, 9, 17, 3, 0);
const RATES = { KR: { fee_rate: 0.00015, tax_rate: 0.002 }, US: { fee_rate: 0.001, tax_rate: 0 } };
const FX: FxQuote = { pair: 'USDKRW', rate: 1300, change_pct: 0.1, ts: KR_OPEN + HOUR, source: 'sim', stale: false };

function unifiedInput(opts: Parameters<typeof pureInput>[0] = {}) {
  return pureInput({
    ...opts,
    league: { market: 'ALL', currency: 'KRW', fx_spread: 0.001, ...opts.league },
    rules: { fx_spread: 0.001, rates: RATES, ...opts.rules },
    marketsOpen: opts.marketsOpen ?? { KR: true, US: false },
    fx: opts.fx === undefined ? FX : opts.fx,
  });
}

const krStocks = symbolsFor('KR').filter((s) => s.kind === 'stock');
const usStocks = symbolsFor('US').filter((s) => s.kind === 'stock');

beforeEach(() => resetEngineState(KR_OPEN + HOUR));
afterEach(() => {
  setProviderResolver(null);
  restoreEngineState();
});

describe('symbol universe of ALL leagues', () => {
  it('is every symbol, and KR and US codes can never collide', () => {
    expect(symbolsFor('ALL')).toHaveLength(SYMBOLS.length);
    expect(new Set(SYMBOLS.map((s) => s.symbol)).size).toBe(SYMBOLS.length);
    for (const s of symbolsFor('KR')) expect(s.symbol).toMatch(/^\d{6}$/);
    for (const s of symbolsFor('US')) expect(s.symbol).toMatch(/^[A-Z][A-Z.-]*$/);
  });
});

describe('selectCandidates for ALL leagues', () => {
  const countBy = (rows: CandidateRow[], market: 'KR' | 'US') => rows.filter((c) => c.market === market).length;

  it('gives the open market 60% of the ranked slots, 9/6 movers and at most 3 leveraged ETFs each', () => {
    const krMovers = krStocks.slice(20, 32).map((s) => s.symbol);
    const usMovers = usStocks.slice(20, 32).map((s) => s.symbol);
    feedMarket('KR', Object.fromEntries(krMovers.map((s, i) => [s, { change_pct: 10 - i * 0.5 }])));
    feedMarket('US', Object.fromEntries(usMovers.map((s, i) => [s, { change_pct: 10 - i * 0.5 }])));
    setFxRate(1300);
    const rows = selectCandidates({ market: 'ALL' }, pureInput().portfolio, [], clockNow()); // KR open, US closed

    const core = [...CORE_CANDIDATES.KR, ...CORE_CANDIDATES.US];
    expect(rows).toHaveLength(MAX_CANDIDATES);
    expect(rows.slice(0, core.length).map((c) => c.symbol)).toEqual(core);
    const ranked = MAX_CANDIDATES - core.length; // 34: KR ceil(20.4) = 21, US 13
    expect(countBy(rows, 'KR')).toBe(CORE_CANDIDATES.KR.length + Math.ceil(ranked * 0.6));
    expect(countBy(rows, 'US')).toBe(CORE_CANDIDATES.US.length + ranked - Math.ceil(ranked * 0.6));
    // Movers first within each market's share.
    expect(rows.slice(6, 15).map((c) => c.symbol)).toEqual(krMovers.slice(0, 9));
    expect(rows.slice(6 + 21, 6 + 21 + 6).map((c) => c.symbol)).toEqual(usMovers.slice(0, 6));
    for (const m of ['KR', 'US'] as const) {
      expect(rows.filter((c) => c.market === m && isLeveraged(getSymbol(c.symbol)!)).length).toBeLessThanOrEqual(3);
    }
    // Rows carry the market, its open state and the KRW price.
    const kr = rows.find((c) => c.market === 'KR')!;
    const us = rows.find((c) => c.market === 'US')!;
    expect(kr).toMatchObject({ market_open: true, price_krw: kr.price });
    expect(us).toMatchObject({ market_open: false, price_krw: Math.round(us.price! * 1300) });
  });

  it('flips the split while only the US is open and halves it while both are closed', () => {
    feedMarket('KR');
    feedMarket('US');
    const usOpen = selectCandidates({ market: 'ALL' }, pureInput().portfolio, [], US_OPEN + HOUR);
    expect(countBy(usOpen, 'US')).toBe(4 + 21);
    expect(countBy(usOpen, 'KR')).toBe(2 + 13);
    const closed = selectCandidates({ market: 'ALL' }, pureInput().portfolio, [], SATURDAY);
    expect(countBy(closed, 'KR')).toBe(2 + 17);
    expect(countBy(closed, 'US')).toBe(4 + 17);
    expect(closed.find((c) => c.market === 'US')!.price_krw).toBeNull(); // no USD/KRW yet
  });

  it('keeps every held and pending symbol and never exceeds 40 otherwise', () => {
    feedMarket('KR');
    feedMarket('US');
    const portfolio = { ...pureInput().portfolio, holdings: [holding('AAPL', 1, 200), holding('000660', 1, 100_000)] };
    const rows = selectCandidates({ market: 'ALL' }, portfolio, [{ symbol: 'TSLA', status: 'pending' }]);
    expect(rows.slice(0, 3).map((c) => c.symbol)).toEqual(['AAPL', '000660', 'TSLA']);
    expect(rows).toHaveLength(MAX_CANDIDATES);
    // Single-market leagues keep their rows compact.
    const krRow = selectCandidates({ market: 'KR' }, pureInput().portfolio)[0]!;
    expect(krRow).not.toHaveProperty('price_krw');
    expect(krRow).toMatchObject({ market: 'KR', market_open: true });
  });
});

describe('runDecision in an ALL league', () => {
  it('passes both markets, rates and FX to the provider and accepts KR and US symbols', async () => {
    feedMarket('KR');
    feedMarket('US');
    setFxRate(1300);
    const { participants } = agentLeague('ALL', [{ name: 'A' }]);
    let seen: Parameters<LLMProvider['decide']>[0] | undefined;
    setProviderResolver(() => ({
      async decide(input) {
        seen = input;
        const decision = {
          market_view: '양쪽 시장',
          orders: [
            { symbol: '005930', side: 'BUY' as const, quantity: 1, reason: 'KR' },
            { symbol: 'aapl', side: 'BUY' as const, quantity: 1, reason: 'US' },
            { symbol: 'ZZZZ', side: 'BUY' as const, quantity: 1, reason: '없음' },
          ],
        };
        return { decision, raw: JSON.stringify(decision) };
      },
    }));
    const log = await runDecision(participants.A!);
    expect(log.accepted_order_ids).toHaveLength(2);
    expect(log.rejected).toEqual([{ symbol: 'ZZZZ', reason: 'unknown_symbol' }]);
    expect(seen!.rules).toMatchObject({ fx_spread: 0.001, rates: RATES });
    expect(seen!).toMatchObject({ marketOpen: true, marketsOpen: { KR: true, US: false }, fx: { rate: 1300 } });
    expect(seen!.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
  });

  it('builds a closed-market input with no rate as marketOpen false', () => {
    setClock(SATURDAY);
    const { participants } = agentLeague('ALL', [{ name: 'A' }], { start_at: SATURDAY });
    const input = buildDecisionInput(participants.A!);
    expect(input).toMatchObject({ marketOpen: false, marketsOpen: { KR: false, US: false }, fx: null });
  });
});

describe('rule strategies in ALL leagues', () => {
  const kr = krStocks.slice(0, 8).map((s, i) => candidate(s.symbol, 50_000, { volume: 1000 - i, market_open: true, price_krw: 50_000 }));

  it('baseline buys 5 KR stocks by KRW traded value while only KR is open, then 5 US stocks', () => {
    const usClosed = usStocks
      .slice(0, 8)
      .map((s, i) => candidate(s.symbol, 200, { volume: 5000 - i, market_open: false, price_krw: 260_000 }));
    const first = decideBaseline(unifiedInput({ candidates: [...usClosed, ...kr] }));
    expect(first.orders.map((o) => o.symbol)).toEqual(kr.slice(0, 5).map((c) => c.symbol));
    expect(first.orders[0]!.reason).toContain('한국 거래대금 상위 1위');
    // 95% / 10 names of 10,000,000 = 950,000 per name at 50,000 → 19 shares.
    expect(first.orders[0]!.quantity).toBe(19);

    const held = kr.slice(0, 5).map((c) => holding(c.symbol, 19, 50_000));
    const usOpen = usClosed.map((c) => ({ ...c, market_open: true }));
    const krClosed = kr.map((c) => ({ ...c, market_open: false }));
    const second = decideBaseline(
      unifiedInput({ cash: 10_000_000 - 5 * 950_000, holdings: held, candidates: [...krClosed, ...usOpen], marketsOpen: { KR: false, US: true } }),
    );
    expect(second.orders.map((o) => o.symbol)).toEqual(usOpen.slice(0, 5).map((c) => c.symbol));
    // Sized in KRW: 950,000 / 260,000 → 3 shares of a $200 stock.
    expect(second.orders.every((o) => o.quantity === 3)).toBe(true);
    // A KR half already held: no more KR names while only KR is open, even with cash left.
    const krAgain = decideBaseline(unifiedInput({ cash: 10_000_000 - 5 * 950_000, holdings: held, candidates: [...usClosed, ...kr] }));
    expect(krAgain.orders).toEqual([]);
  });

  it('baseline skips names whose share price exceeds one equal-weight slot', () => {
    const pricey = candidate(krStocks[10]!.symbol, 1_400_000, { volume: 10_000, price_krw: 1_400_000 });
    const decision = decideBaseline(unifiedInput({ candidates: [pricey, ...kr] }));
    expect(decision.orders.map((o) => o.symbol)).toEqual(kr.slice(0, 5).map((c) => c.symbol));
  });

  it('momentum trades only symbols whose market is open', () => {
    const decision = decideMomentum(
      unifiedInput({
        holdings: [holding('005930', 10, 80_000), holding('TSLA', 10, 300)],
        candidates: [
          candidate('005930', 80_000, { change_pct: -3, price_krw: 80_000 }),
          candidate('TSLA', 300, { change_pct: -5, market_open: false, price_krw: 390_000 }),
          candidate('000660', 100_000, { change_pct: 3, price_krw: 100_000 }),
          candidate('NVDA', 200, { change_pct: 6, market_open: false, price_krw: 260_000 }),
        ],
      }),
    );
    expect(decision.orders.map((o) => [o.side, o.symbol])).toEqual([
      ['SELL', '005930'],
      ['BUY', '000660'],
    ]);
  });
});

describe('buildPrompt for ALL leagues', () => {
  const input = unifiedInput({
    holdings: [holding('AAPL', 2, 200)],
    candidates: [
      candidate('005930', 80_000, { price_krw: 80_000 }),
      candidate('AAPL', 200, { market_open: false, price_krw: 260_000 }),
    ],
  });

  it('explains the KRW account, per-market fees, FX conversion and both sessions', () => {
    const { system, user } = buildPrompt(input);
    expect(system).toContain('한국·미국 주식과 ETF를 하나의 원화 계좌로 거래하며');
    expect(system).toContain('한국 종목 0.015%, 미국 종목 0.1%');
    expect(system).toContain('한국 주식 매도 금액의 0.2% (매도 시에만, ETF 매도는 증권거래세 면제)');
    expect(system).toContain('환전 비용은 매수·매도 각 0.1%');
    expect(system).toContain('리그 종료 전에 다시 열리지 않는 시장의 종목은 주문할 수 없습니다');
    expect(user).toContain('환율(USD/KRW): 중간값 1,300.00원 · 매수 적용 1,301.30원 · 매도 적용 1,298.70원 · 기준 2026-10-19 10:00 (Asia/Seoul)');
    expect(user).toContain('한국 장: 열림 · 미국 장: 닫힘');
    expect(user).toContain('뉴욕 2026-10-18 21:00 (America/New_York)');

    const rows = JSON.parse(/<data name="candidates">\n([\s\S]*?)\n<\/data>/.exec(user)![1]!) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ symbol: '005930', market: 'KR', currency: 'KRW', market_open: true, price: 80_000 });
    expect(rows[0]).not.toHaveProperty('price_krw');
    expect(rows[1]).toMatchObject({ symbol: 'AAPL', market: 'US', currency: 'USD', market_open: false, price: 200, price_krw: 260_000 });
    expect(user).toMatch(/"currency": "USD",\n\s+"quantity": 2/);
  });

  it('flags a stale or missing rate', () => {
    expect(buildPrompt(unifiedInput({ fx: { ...FX, stale: true } })).user).toContain('30분 넘게 갱신되지 않음');
    expect(buildPrompt(unifiedInput({ fx: null })).user).toContain('환율(USD/KRW): 정보 없음');
  });

  it('leaves single-market prompts without market or FX fields', () => {
    const { system, user } = buildPrompt(pureInput({ candidates: [candidate('005930', 80_000)] }));
    expect(system).toContain('한국(KOSPI/KOSDAQ) 주식과 ETF를 거래하며');
    expect(user).not.toContain('환율');
    const rows = JSON.parse(/<data name="candidates">\n([\s\S]*?)\n<\/data>/.exec(user)![1]!) as Record<string, unknown>[];
    expect(rows[0]).not.toHaveProperty('market');
    expect(rows[0]).not.toHaveProperty('market_open');
  });
});
