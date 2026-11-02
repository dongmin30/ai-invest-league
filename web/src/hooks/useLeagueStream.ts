import { useEffect, useRef, useState } from 'react';
import type { StreamEvent } from '@shared/api-types';

export type StreamState = 'connecting' | 'open' | 'reconnecting';

const MAX_BACKOFF_MS = 30_000;

function parseEvent(raw: string): StreamEvent | null {
  try {
    const value = JSON.parse(raw) as { type?: unknown };
    if (
      value &&
      (value.type === 'quotes' ||
        value.type === 'rankings' ||
        value.type === 'decision' ||
        value.type === 'order' ||
        value.type === 'fx')
    ) {
      return value as StreamEvent;
    }
  } catch {
    // Malformed frames are ignored; the next event will carry fresh state.
  }
  return null;
}

/**
 * Subscribes to `/api/stream?league_id=` and reconnects with exponential backoff when the
 * connection drops. `onEvent` may change between renders without reopening the stream.
 */
export function useLeagueStream(
  leagueId: number | null | undefined,
  onEvent: (event: StreamEvent) => void,
): StreamState {
  const [state, setState] = useState<StreamState>('connecting');
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!leagueId) return;
    let source: EventSource | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setState(attempt === 0 ? 'connecting' : 'reconnecting');
      source = new EventSource(`/api/stream?league_id=${leagueId}`, { withCredentials: true });
      source.onopen = () => {
        attempt = 0;
        setState('open');
      };
      source.onmessage = (msg: MessageEvent<string>) => {
        const event = parseEvent(msg.data);
        if (event) handler.current(event);
      };
      source.onerror = () => {
        if (!source || disposed) return;
        // The browser retries on its own while CONNECTING; take over once it gives up.
        if (source.readyState === EventSource.CLOSED) {
          source.close();
          attempt++;
          setState('reconnecting');
          const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 5));
          timer = window.setTimeout(connect, delay);
        } else {
          setState('reconnecting');
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      source?.close();
    };
  }, [leagueId]);

  return state;
}
