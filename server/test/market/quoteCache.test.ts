import { afterEach, describe, expect, it } from 'vitest';
import type { Quote } from '../../../shared/api-types';
import { clearQuotes, getQuote, setQuotes } from '../../src/market/quoteCache';

const T = Date.UTC(2026, 9, 19, 1, 0);

function q(price: number, ts: number): Quote {
  return { symbol: '005930', market: 'KR', price, change_pct: 0, volume: 0, ts, source: 'sim' };
}

describe('quoteCache.setQuotes', () => {
  afterEach(() => clearQuotes());

  it('never replaces a cached quote with an older one (e.g. overlapping collects)', () => {
    setQuotes([q(71_000, T + 60_000)]);
    setQuotes([q(70_000, T)]); // a slower fetch that started earlier lands last
    expect(getQuote('005930')).toMatchObject({ price: 71_000, ts: T + 60_000 });

    setQuotes([q(72_000, T + 60_000)]); // same timestamp: the later write wins
    expect(getQuote('005930')).toMatchObject({ price: 72_000 });
    setQuotes([q(73_000, T + 120_000)]);
    expect(getQuote('005930')).toMatchObject({ price: 73_000, ts: T + 120_000 });
  });
});
