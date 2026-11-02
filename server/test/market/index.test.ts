import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config';
import { setNow } from '../../src/lib/time';
import { getProvider, marketStatus } from '../../src/market';

const saved = {
  priceProvider: config.priceProvider,
  kisAppKey: config.kisAppKey,
  kisAppSecret: config.kisAppSecret,
  simAlwaysOpen: config.simAlwaysOpen,
};
const KR_OPEN = Date.UTC(2026, 9, 19, 1, 0); // Mon 10:00 KST, Sun 21:00 EDT

beforeEach(() => {
  Object.assign(config, { priceProvider: 'yahoo', kisAppKey: undefined, kisAppSecret: undefined, simAlwaysOpen: false });
  setNow(() => KR_OPEN);
});

afterEach(() => {
  Object.assign(config, saved);
  setNow(null);
  vi.restoreAllMocks();
});

describe('getProvider', () => {
  it('defaults to yahoo and caches the instance', () => {
    expect(getProvider().name).toBe('yahoo');
    expect(getProvider()).toBe(getProvider());
  });

  it('falls back to yahoo with a warning when KIS keys are missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    config.priceProvider = 'kis';
    expect(getProvider().name).toBe('yahoo');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('KIS_APP_KEY'));
  });

  it('uses kis when keys are present, and sim on request', () => {
    config.priceProvider = 'kis';
    config.kisAppKey = 'k';
    config.kisAppSecret = 's';
    expect(getProvider().name).toBe('kis');
    config.priceProvider = 'sim';
    expect(getProvider().name).toBe('sim');
  });
});

describe('marketStatus', () => {
  it('reports an open market with its close and the provider note', () => {
    expect(marketStatus('KR')).toEqual({
      market: 'KR',
      open: true,
      next_open: null,
      next_close: Date.UTC(2026, 9, 19, 6, 30),
      provider: 'yahoo',
      note: '시세 출처: Yahoo Finance · 실시간이 아닐 수 있음',
    });
  });

  it('reports a closed market with the next session', () => {
    const s = marketStatus('US');
    expect(s.open).toBe(false);
    expect(s.next_open).toBe(Date.UTC(2026, 9, 19, 13, 30)); // Mon 09:30 EDT
    expect(s.next_close).toBe(Date.UTC(2026, 9, 19, 20, 0));
  });

  it('marks simulated and demo-mode prices', () => {
    config.priceProvider = 'sim';
    config.simAlwaysOpen = true;
    const s = marketStatus('US');
    expect(s.open).toBe(true);
    expect(s.provider).toBe('sim');
    expect(s.note).toContain('시뮬레이션');
    expect(s.note).toContain('데모 모드');
  });
});
