import path from 'node:path';
import type { Market, MarketStatus } from '../../../shared/api-types';
import { config } from '../config';
import { now } from '../lib/time';
import { currentSessionEnd, marketSession, nextTradable, quoteDelayMs } from './calendar';
import { createKisProvider, krFromKis } from './providers/kis';
import { createSimProvider } from './providers/sim';
import type { PriceProvider } from './providers/types';
import { createYahooProvider } from './providers/yahoo';

let cached: { key: string; provider: PriceProvider } | undefined;

function build(): PriceProvider {
  switch (config.priceProvider) {
    case 'sim':
      // Practice mode starts from real latest prices when the DB has none (spark only, one shot).
      return createSimProvider({
        seed: (symbols) => createYahooProvider({ fallback: false }).fetchQuotes(symbols),
        seedFx: () => createYahooProvider().fetchFx!(),
      });
    case 'kis':
    case 'kis_kr':
      if (config.kisAppKey && config.kisAppSecret) {
        const yahoo = createYahooProvider();
        const kis = createKisProvider({
          appKey: config.kisAppKey,
          appSecret: config.kisAppSecret,
          baseUrl: config.kisBaseUrl,
          tokenFile: path.join(config.dataDir, 'kis-token.json'),
          dailyBars: yahoo,
        });
        return config.priceProvider === 'kis_kr' ? krFromKis(kis, yahoo) : kis;
      }
      console.warn(`[market] PRICE_PROVIDER=${config.priceProvider} but KIS_APP_KEY/KIS_APP_SECRET are missing; falling back to yahoo`);
      return createYahooProvider();
    case 'yahoo':
      return createYahooProvider();
  }
}

/** The configured provider, created once and rebuilt only if the relevant config changes. */
export function getProvider(): PriceProvider {
  const key = [config.priceProvider, config.kisAppKey ?? '', config.kisAppSecret ?? '', config.kisBaseUrl].join('|');
  if (cached?.key !== key) cached = { key, provider: build() };
  return cached.provider;
}

const NOTES: Record<PriceProvider['name'], string> = {
  yahoo: '시세 출처: Yahoo Finance · 실시간이 아닐 수 있음',
  kis: '시세 출처: 한국투자증권 Open API',
  sim: '시뮬레이션 시세 · 실제 가격이 아닙니다',
};

export function marketStatus(market: Market): MarketStatus {
  const at = now();
  const session = marketSession(market, at);
  const open = session !== 'closed';
  // With kis_kr only KR quotes come from KIS.
  const provider = config.priceProvider === 'kis_kr' && market === 'US' ? 'yahoo' : getProvider().name;
  const delayMin = Math.round(quoteDelayMs(market) / 60_000);
  const source = delayMin > 0 ? `시세 출처: Yahoo Finance · 약 ${delayMin}분 지연 시세` : NOTES[provider];
  const note = config.simAlwaysOpen ? `${source} · 데모 모드(장 시간 무시)` : source;
  return {
    market,
    open,
    session,
    next_open: open ? null : nextTradable(market, at),
    next_close: currentSessionEnd(market, at),
    provider,
    note,
  };
}
