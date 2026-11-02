import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Quote } from '@shared/api-types';
import { api } from '../api/client';

interface PriceInfo {
  source: Quote['source'] | null;
  /** Newest quote timestamp the UI has seen (source time). */
  lastQuoteTs: number | null;
}

interface PriceInfoValue extends PriceInfo {
  reportQuotes: (quotes: { ts: number | null; source?: Quote['source'] }[]) => void;
}

const PriceInfoContext = createContext<PriceInfoValue | null>(null);

/** Tracks the price source and latest quote time for the global footer. */
export function PriceInfoProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<PriceInfo>({ source: null, lastQuoteTs: null });

  useEffect(() => {
    api.health().then(
      (h) => setInfo((prev) => ({ ...prev, source: prev.source ?? h.provider })),
      () => undefined,
    );
  }, []);

  const reportQuotes = useCallback<PriceInfoValue['reportQuotes']>((quotes) => {
    let latest: number | null = null;
    let source: Quote['source'] | undefined;
    for (const q of quotes) {
      if (q.ts !== null && (latest === null || q.ts > latest)) {
        latest = q.ts;
        source = q.source ?? source;
      }
    }
    if (latest === null) return;
    const ts = latest;
    setInfo((prev) => ({
      source: source ?? prev.source,
      lastQuoteTs: prev.lastQuoteTs !== null && prev.lastQuoteTs > ts ? prev.lastQuoteTs : ts,
    }));
  }, []);

  const value = useMemo(() => ({ ...info, reportQuotes }), [info, reportQuotes]);
  return <PriceInfoContext.Provider value={value}>{children}</PriceInfoContext.Provider>;
}

export function usePriceInfo(): PriceInfoValue {
  const ctx = useContext(PriceInfoContext);
  if (!ctx) throw new Error('usePriceInfo must be used inside <PriceInfoProvider>');
  return ctx;
}
