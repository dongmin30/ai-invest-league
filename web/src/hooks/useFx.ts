import { useCallback, useEffect, useState } from 'react';
import type { FxQuote } from '@shared/api-types';
import { api } from '../api/client';

/**
 * Live USD/KRW for a 통합 league. The stream sends no `fx` frame on connect, so the current rate is
 * fetched once from /market/fx; `push` takes later quotes (stream events, portfolio reloads) and
 * keeps whichever is newest. Disabled (single-market leagues) it stays null and fetches nothing.
 */
export function useFx(enabled: boolean): { fx: FxQuote | null; push: (next: FxQuote | null | undefined) => void } {
  const [fx, setFx] = useState<FxQuote | null>(null);

  const push = useCallback((next: FxQuote | null | undefined) => {
    if (!next) return;
    setFx((current) => (current && current.ts > next.ts ? current : next));
  }, []);

  useEffect(() => {
    if (!enabled) {
      setFx(null);
      return;
    }
    let alive = true;
    api.fx().then(
      (rate) => {
        if (alive) push(rate);
      },
      () => undefined, // The badge shows "수신 대기" until a stream event arrives.
    );
    return () => {
      alive = false;
    };
  }, [enabled, push]);

  return { fx, push };
}
