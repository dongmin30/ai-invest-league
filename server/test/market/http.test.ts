import { describe, expect, it } from 'vitest';
import { backoffMs, createLimiter, createRateLimiter } from '../../src/market/providers/http';

describe('createLimiter', () => {
  it('caps concurrency and keeps running after a task fails', async () => {
    const run = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = (fail: boolean) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      if (fail) throw new Error('boom');
      return 1;
    };
    const results = await Promise.allSettled([true, false, false, true, false].map((f) => run(task(f))));
    expect(peak).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  });
});

describe('createRateLimiter', () => {
  it('allows a burst of `rate` and then about `rate` per second', async () => {
    const take = createRateLimiter(15);
    const start = Date.now();
    for (let i = 0; i < 15; i++) await take();
    expect(Date.now() - start).toBeLessThan(50);
    await Promise.all(Array.from({ length: 5 }, () => take()));
    // Five extra tokens at 15/s need about 333ms.
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  });
});

describe('backoffMs', () => {
  it('honors Retry-After seconds and grows exponentially otherwise', () => {
    expect(backoffMs(1, 500, '2')).toBe(2000);
    expect(backoffMs(1, 500, '999')).toBe(10_000);
    const first = backoffMs(1, 400);
    const third = backoffMs(3, 400);
    expect(first).toBeGreaterThanOrEqual(300);
    expect(first).toBeLessThanOrEqual(500);
    expect(third).toBeGreaterThanOrEqual(1200);
    expect(third).toBeLessThanOrEqual(2000);
  });
});
