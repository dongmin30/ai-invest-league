// Small concurrency / rate-limit helpers shared by the network providers.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs at most `max` tasks at once; extra calls wait in FIFO order. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    active--;
    waiting.shift()?.();
  };

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/** Token bucket: `ratePerSec` tokens per second, burst of `ratePerSec`. */
export function createRateLimiter(ratePerSec: number, clock: () => number = Date.now) {
  let tokens = ratePerSec;
  let last = clock();
  let queue: Promise<void> = Promise.resolve();

  const refill = () => {
    const t = clock();
    tokens = Math.min(ratePerSec, tokens + ((t - last) / 1000) * ratePerSec);
    last = t;
  };

  const takeOne = async () => {
    refill();
    while (tokens < 1) {
      await sleep(Math.ceil(((1 - tokens) / ratePerSec) * 1000));
      refill();
    }
    tokens -= 1;
  };

  // Callers are serialized through `queue` so concurrent waiters cannot overdraw the bucket.
  return function take(): Promise<void> {
    const next = queue.then(takeOne);
    queue = next.catch(() => undefined);
    return next;
  };
}

/** Delay before retry `attempt` (1-based): exponential with jitter, honoring Retry-After. */
export function backoffMs(attempt: number, baseMs: number, retryAfter?: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  return baseMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
