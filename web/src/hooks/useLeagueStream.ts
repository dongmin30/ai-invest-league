import { useEffect, useRef, useState } from 'react';
import type { StreamEvent } from '@shared/api-types';

/** `polling`: the stream is open but silent (a proxy holds it back), so the page polls instead. */
export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'polling';

const MAX_BACKOFF_MS = 30_000;
/** The server pings on open; no ping this long after opening means the stream is held back. */
const FIRST_PING_MS = 8_000;
/** The server pings every 20s; two missed pings count as stalled. */
const STALL_MS = 50_000;
const WATCH_MS = 4_000;
export const POLL_MS = 15_000;

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
 * connection drops. While the stream is down or silent, `onPoll` runs every POLL_MS (and once
 * on entering that state) so the page can refetch what the stream would have pushed.
 * `onEvent` and `onPoll` may change between renders without reopening the stream.
 */
export function useLeagueStream(
  leagueId: number | null | undefined,
  onEvent: (event: StreamEvent) => void,
  onPoll?: () => void,
): StreamState {
  const [state, setState] = useState<StreamState>('connecting');
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const poller = useRef(onPoll);
  poller.current = onPoll;

  useEffect(() => {
    if (!leagueId) return;
    let source: EventSource | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let disposed = false;
    /** When the current EventSource was created / opened (headers received). */
    let startedAt: number | null = null;
    let openedAt: number | null = null;
    let lastPing: number | null = null;

    const alive = () => {
      lastPing = Date.now();
      setState('open');
    };

    const connect = () => {
      if (disposed) return;
      setState(attempt === 0 ? 'connecting' : 'reconnecting');
      startedAt = Date.now();
      openedAt = null;
      lastPing = null;
      source = new EventSource(`/api/stream?league_id=${leagueId}`, { withCredentials: true });
      source.onopen = () => {
        attempt = 0;
        openedAt = Date.now();
      };
      source.addEventListener('ping', alive);
      source.onmessage = (msg: MessageEvent<string>) => {
        alive();
        const event = parseEvent(msg.data);
        if (event) handler.current(event);
      };
      source.onerror = () => {
        if (!source || disposed) return;
        openedAt = null;
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

    // Detects a silent stream (open but held back, or a first connect whose headers never come);
    // the pings resume `open` if it starts flowing. Errors are handled as `reconnecting`, which polls too.
    const watchdog = window.setInterval(() => {
      const now = Date.now();
      let silent: boolean;
      if (lastPing !== null) silent = now - lastPing > STALL_MS;
      else if (openedAt !== null) silent = now - openedAt > FIRST_PING_MS;
      else silent = startedAt !== null && source?.readyState === EventSource.CONNECTING && now - startedAt > FIRST_PING_MS;
      if (silent) setState('polling');
    }, WATCH_MS);

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearInterval(watchdog);
      source?.close();
    };
  }, [leagueId]);

  // Poll while there is no live stream (down or silent), not during the first connect.
  const shouldPoll = Boolean(leagueId) && (state === 'polling' || state === 'reconnecting');
  useEffect(() => {
    if (!shouldPoll) return;
    poller.current?.();
    const id = window.setInterval(() => poller.current?.(), POLL_MS);
    return () => window.clearInterval(id);
  }, [shouldPoll]);

  return state;
}
