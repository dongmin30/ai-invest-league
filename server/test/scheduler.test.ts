import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quote, RankingRow } from '../../shared/api-types';
import { config } from '../src/config';
import { db } from '../src/db/db';
import { getLeagueRow, getOrderRow, getParticipantRow } from '../src/engine/store';
import { bus } from '../src/lib/bus';
import type { Collector } from '../src/market/collector';
import { POST_CLOSE_FETCH_MS } from '../src/market/calendar';
import { setQuotes } from '../src/market/quoteCache';
import { startScheduler, type Scheduler } from '../src/scheduler';
import {
  KR_CLOSE,
  KR_OPEN,
  MIN,
  US_OPEN,
  activeLeague,
  buy,
  clockNow,
  quote,
  resetEngineState,
  restoreEngineState,
  setClock,
  setFxRate,
} from './engine/helpers';

const SAMSUNG = '005930';

function fakeCollector(tick: () => Promise<Quote[]>): Collector & { tick: ReturnType<typeof vi.fn> } {
  return { tick: vi.fn(tick), loadDailyBars: vi.fn(async () => {}) };
}

describe('startScheduler', () => {
  let scheduler: Scheduler | undefined;

  beforeEach(() => {
    resetEngineState();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    await scheduler?.stop(100);
    scheduler = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreEngineState();
  });

  it('first cycle collects, fills pending orders and publishes rankings', async () => {
    const { leagueId, participantId } = activeLeague('KR');
    setQuotes([quote(SAMSUNG, 70_000)]);
    const order = buy(participantId, SAMSUNG, 1);

    const rankings: { league_id: number; rankings: RankingRow[] }[] = [];
    const onRankings = (e: (typeof rankings)[number]) => rankings.push(e);
    bus.on('rankings', onRankings);
    try {
      setClock(clockNow() + MIN);
      const collector = fakeCollector(async () => {
        const q = [quote(SAMSUNG, 71_000)];
        setQuotes(q);
        return q;
      });
      scheduler = startScheduler({ collector });
      await scheduler.ready;

      expect(collector.tick).toHaveBeenCalledTimes(1);
      expect(getOrderRow(order.id)).toMatchObject({ status: 'filled', fill_price: 71_000 });
      const mine = rankings.find((e) => e.league_id === leagueId);
      expect(mine?.rankings[0]).toMatchObject({ participant_id: participantId, eligible: true, rank: 1 });
    } finally {
      bus.off('rankings', onRankings);
    }
  });

  it('never overlaps a slow collect and keeps running after a failure', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const collector = fakeCollector(() => {
      calls++;
      if (calls === 1) return new Promise<Quote[]>((resolve) => (release = () => resolve([])));
      return Promise.reject(new Error('provider down'));
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    scheduler = startScheduler({ collector });
    await vi.advanceTimersByTimeAsync(config.collectIntervalSec * 1000 * 3);
    expect(collector.tick).toHaveBeenCalledTimes(1);

    release!();
    await scheduler.ready;
    await vi.advanceTimersByTimeAsync(config.collectIntervalSec * 1000);
    expect(collector.tick).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('[scheduler] collect failed:', expect.any(Error));

    await vi.advanceTimersByTimeAsync(config.collectIntervalSec * 1000);
    expect(collector.tick).toHaveBeenCalledTimes(3);
  });

  it('at a market close, collects the closing prints before finishing leagues', async () => {
    const interval = config.collectIntervalSec;
    config.collectIntervalSec = 3600; // only the leagues job may trigger a collect here
    try {
      setClock(KR_CLOSE - 10 * MIN);
      const { leagueId, participantId } = activeLeague('KR', { duration_days: 1, start_at: KR_OPEN });
      db.prepare('INSERT INTO holdings (participant_id, symbol, quantity, avg_price) VALUES (?, ?, 10, 70000)').run(
        participantId,
        SAMSUNG,
      );
      let price = 70_000;
      const collector = fakeCollector(async () => {
        await Promise.resolve();
        const q = [quote(SAMSUNG, price, clockNow())];
        setQuotes(q);
        return q;
      });
      scheduler = startScheduler({ collector });
      await scheduler.ready;
      expect(collector.tick).toHaveBeenCalledTimes(1);

      setClock(KR_CLOSE + 30_000);
      price = 80_000; // the closing auction print
      await vi.advanceTimersByTimeAsync(MIN);
      expect(collector.tick).toHaveBeenCalledTimes(2);
      expect(getLeagueRow(leagueId)!.status).toBe('finished');
      // Valued at the closing print (80,000), not the last pre-close quote (70,000).
      expect(getParticipantRow(participantId)!.final_return).toBeCloseTo((10 * 80_000) / 10_000_000);
    } finally {
      config.collectIntervalSec = interval;
    }
  });

  it('at a close, fetches afresh instead of reusing the collect run of the same tick', async () => {
    expect(config.collectIntervalSec).toBe(60); // collect and leagues fire in lockstep
    setClock(KR_CLOSE - 10 * MIN);
    const { leagueId, participantId } = activeLeague('KR', { duration_days: 1, start_at: KR_OPEN });
    db.prepare('INSERT INTO holdings (participant_id, symbol, quantity, avg_price) VALUES (?, ?, 10, 70000)').run(
      participantId,
      SAMSUNG,
    );
    const prints = [
      quote(SAMSUNG, 70_000, KR_CLOSE - 10 * MIN),
      quote(SAMSUNG, 70_000, KR_CLOSE - 5_000), // delayed feed: still the pre-close price
      quote(SAMSUNG, 80_000, KR_CLOSE + 5_000), // the closing print
    ];
    const collector = fakeCollector(async () => {
      // A real network round trip: the leagues job fires while this fetch is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const q = [prints.shift() ?? quote(SAMSUNG, 80_000, clockNow())];
      setQuotes(q);
      return q;
    });
    scheduler = startScheduler({ collector });
    await scheduler.ready;

    setClock(KR_CLOSE + 30_000);
    await vi.advanceTimersByTimeAsync(MIN);
    await vi.waitFor(() => expect(getLeagueRow(leagueId)!.status).toBe('finished'));
    expect(collector.tick).toHaveBeenCalledTimes(3);
    expect(getParticipantRow(participantId)!.final_return).toBeCloseTo((10 * 80_000) / 10_000_000);
  });

  describe('at-close snapshot', () => {
    let interval: number;
    beforeEach(() => {
      interval = config.collectIntervalSec;
      config.collectIntervalSec = 3600; // only the leagues job collects here
    });
    afterEach(() => {
      config.collectIntervalSec = interval;
    });

    const snapshotsOf = (pid: number) =>
      db.prepare('SELECT ts, equity FROM snapshots WHERE participant_id = ? ORDER BY ts').all(pid);

    /** A league that keeps running past today's close, holding 10 shares; the feed lags the close. */
    async function startAtClose(): Promise<number> {
      setClock(KR_CLOSE - 10 * MIN);
      const { participantId } = activeLeague('KR', { duration_days: 5, start_at: KR_OPEN });
      db.prepare('INSERT INTO holdings (participant_id, symbol, quantity, avg_price) VALUES (?, ?, 10, 70000)').run(
        participantId,
        SAMSUNG,
      );
      const prints = [quote(SAMSUNG, 70_000, KR_CLOSE - 10 * MIN)];
      const collector = fakeCollector(async () => {
        // Delayed feed: still the last pre-close print.
        const q = [prints.shift() ?? quote(SAMSUNG, 70_000, KR_CLOSE - 5_000)];
        setQuotes(q);
        return q;
      });
      scheduler = startScheduler({ collector });
      await scheduler.ready;
      setClock(KR_CLOSE + 30_000);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(collector.tick).toHaveBeenCalledTimes(2); // the fresh post-close fetch ran
      return participantId;
    }

    it('waits for the closing print of every held symbol, then snapshots exactly once', async () => {
      const pid = await startAtClose();
      expect(snapshotsOf(pid)).toEqual([]);

      setQuotes([quote(SAMSUNG, 80_000, KR_CLOSE + 5_000)]); // a later collect brings the closing print
      setClock(KR_CLOSE + 90_000);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(snapshotsOf(pid)).toEqual([{ ts: KR_CLOSE + 90_000, equity: 10_000_000 + 10 * 80_000 }]);

      for (const t of [KR_CLOSE + 3 * MIN, KR_CLOSE + POST_CLOSE_FETCH_MS, KR_CLOSE + POST_CLOSE_FETCH_MS + MIN]) {
        setClock(t);
        await vi.advanceTimersByTimeAsync(MIN);
      }
      expect(snapshotsOf(pid)).toHaveLength(1);
    });

    it('snapshots an ALL league at the KR close and at the US close, each waiting only for its own market', async () => {
      const usClose = Date.UTC(2026, 9, 19, 20, 0); // Tuesday 05:00 KST
      setClock(KR_CLOSE - 10 * MIN);
      const { participantId: pid } = activeLeague('ALL', { duration_days: 5, start_at: KR_OPEN });
      const hold = db.prepare('INSERT INTO holdings (participant_id, symbol, quantity, avg_price, avg_fx) VALUES (?, ?, 10, ?, ?)');
      hold.run(pid, SAMSUNG, 70_000, 1);
      hold.run(pid, 'AAPL', 200, 1300);
      setFxRate(1300);
      // AAPL's last print is from the previous US session: it must not hold back the KR close snapshot.
      setQuotes([quote(SAMSUNG, 70_000, KR_CLOSE - 10 * MIN), quote('AAPL', 200, KR_CLOSE - 12 * 60 * MIN)]);
      scheduler = startScheduler({ collector: fakeCollector(async () => []) });
      await scheduler.ready;

      setQuotes([quote(SAMSUNG, 80_000, KR_CLOSE + 5_000)]);
      setClock(KR_CLOSE + 30_000);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(snapshotsOf(pid)).toEqual([{ ts: KR_CLOSE + 30_000, equity: 10_000_000 + 10 * 80_000 + 10 * 200 * 1300 }]);

      setClock(US_OPEN + MIN);
      await vi.advanceTimersByTimeAsync(MIN);
      setClock(usClose + 30_000);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(snapshotsOf(pid)).toHaveLength(1); // waits for the US closing print

      setQuotes([quote('AAPL', 210, usClose + 5_000)]);
      setFxRate(1310, usClose);
      setClock(usClose + 90_000);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(snapshotsOf(pid)).toEqual([
        { ts: KR_CLOSE + 30_000, equity: 10_000_000 + 10 * 80_000 + 10 * 200 * 1300 },
        { ts: usClose + 90_000, equity: 10_000_000 + 10 * 80_000 + 10 * 210 * 1310 },
      ]);
    });

    it('snapshots at close + POST_CLOSE_FETCH_MS at the latest when no closing print arrives', async () => {
      const pid = await startAtClose();
      setClock(KR_CLOSE + POST_CLOSE_FETCH_MS - 1);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(snapshotsOf(pid)).toEqual([]);

      setClock(KR_CLOSE + POST_CLOSE_FETCH_MS);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(snapshotsOf(pid)).toEqual([{ ts: KR_CLOSE + POST_CLOSE_FETCH_MS, equity: 10_000_000 + 10 * 70_000 }]);

      setClock(KR_CLOSE + POST_CLOSE_FETCH_MS + MIN);
      await vi.advanceTimersByTimeAsync(MIN);
      expect(snapshotsOf(pid)).toHaveLength(1);
    });
  });

  it('takes periodic snapshots only for leagues whose market is open', async () => {
    const kr = activeLeague('KR');
    const us = activeLeague('US', { start_at: clockNow() }); // US is closed at 10:00 KST
    const count = (pid: number) =>
      db.prepare('SELECT COUNT(*) FROM snapshots WHERE participant_id = ?').pluck().get(pid) as number;

    scheduler = startScheduler({ collector: fakeCollector(async () => []) });
    await scheduler.ready;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(count(kr.participantId)).toBe(1);
    expect(count(us.participantId)).toBe(0);
  });

  it('stop() clears every timer', async () => {
    const collector = fakeCollector(async () => []);
    scheduler = startScheduler({ collector });
    await scheduler.ready;
    await scheduler.stop(100);
    await vi.advanceTimersByTimeAsync(config.collectIntervalSec * 1000 * 5);
    expect(collector.tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
