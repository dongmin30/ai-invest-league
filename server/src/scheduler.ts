import type { LeagueMarket, Market, Quote } from '../../shared/api-types';
import { runDueAgents } from './agents/runner';
import { config } from './config';
import { db } from './db/db';
import { ensureOfficialLeagues, hasClosingQuotes, updateLeagueStatuses } from './engine/leagues';
import { matchOrders } from './engine/matcher';
import { computeRankings } from './engine/ranking';
import { takeSnapshots } from './engine/snapshots';
import { bus } from './lib/bus';
import { now } from './lib/time';
import { isMarketOpen, marketDate, POST_CLOSE_FETCH_MS, sessionBounds } from './market/calendar';
import { createCollector, type Collector } from './market/collector';
import { getProvider } from './market/index';

const MINUTE_MS = 60_000;
const SNAPSHOT_MS = 10 * MINUTE_MS;
const MARKETS: Market[] = ['KR', 'US'];

export interface SchedulerOptions {
  /** Collector to tick; defaults to one over the configured provider. */
  collector?: Collector;
}

export interface Scheduler {
  /** Resolves after the first cycle (collect, leagues, agents) has run. */
  ready: Promise<void>;
  /** Clears every timer and waits (up to `timeoutMs`) for running jobs to finish. */
  stop(timeoutMs?: number): Promise<void>;
}

interface Job {
  run(): Promise<void>;
  /** Resolves when the current run (if any) has finished. */
  idle(): Promise<void>;
}

/** Wraps a job so runs never overlap and failures are logged instead of crashing the process. */
function guarded(name: string, fn: () => unknown): Job {
  let current: Promise<void> | null = null;
  return {
    run() {
      if (current) return current;
      current = (async () => {
        try {
          await fn();
        } catch (err) {
          console.error(`[scheduler] ${name} failed:`, err);
        } finally {
          current = null;
        }
      })();
      return current;
    },
    idle: () => current ?? Promise.resolve(),
  };
}

/** Active leagues trading any of `markets`: their own market, and ALL (통합) leagues whenever `markets` is non-empty. */
function activeLeagueIds(markets: Market[] = MARKETS): number[] {
  return (
    db.prepare("SELECT id, market FROM leagues WHERE status = 'active' ORDER BY id").all() as { id: number; market: LeagueMarket }[]
  )
    .filter((l) => (l.market === 'ALL' ? markets.length > 0 : markets.includes(l.market)))
    .map((l) => l.id);
}

/** Snapshots the active leagues of `markets` (once each); closed-market sessions are flat, so they are skipped. */
function snapshotMarkets(markets: Market[]): void {
  for (const leagueId of activeLeagueIds(markets)) takeSnapshots(leagueId);
}

function publishRankings(): void {
  for (const leagueId of activeLeagueIds()) {
    bus.emit('rankings', { league_id: leagueId, rankings: computeRankings(leagueId) });
  }
}

export function startScheduler(opts: SchedulerOptions = {}): Scheduler {
  const collector = opts.collector ?? createCollector(getProvider());
  const timers: NodeJS.Timeout[] = [];
  const wasOpen = new Map<Market, boolean>(MARKETS.map((m) => [m, isMarketOpen(m, now())]));
  /** Session close per market whose at-close snapshot is still due. */
  const closeSnapshotDue = new Map<Market, number>();

  const collect = guarded('collect', async () => {
    const quotes: Quote[] = await collector.tick();
    if (quotes.length > 0) matchOrders(quotes);
    publishRankings();
  });

  const snapshots = guarded('snapshots', () => {
    snapshotMarkets(MARKETS.filter((m) => isMarketOpen(m, now())));
  });

  const dailyBars = guarded('daily bars', () => collector.loadDailyBars());

  const leagues = guarded('leagues', async () => {
    const justClosed = MARKETS.filter((market) => {
      const open = isMarketOpen(market, now());
      const closed = wasOpen.get(market) === true && !open;
      wasOpen.set(market, open);
      return closed;
    });
    // Pick up the closing prints before leagues finish and the at-close snapshot is taken. The
    // collect job shares this tick, so wait for its run and start a fresh fetch rather than reuse it.
    if (justClosed.length > 0) {
      await collect.idle();
      await collect.run();
    }

    const { activated, finished } = updateLeagueStatuses();
    const created = ensureOfficialLeagues();
    if (activated.length + finished.length + created.length > 0) {
      console.log(
        `[scheduler] leagues: activated ${activated.length}, finished ${finished.length}, created ${created.length}`,
      );
    }

    // A snapshot at each close records the session's final equity, taken once the closing prints
    // of every held or pending-order symbol are in, or POST_CLOSE_FETCH_MS after the close at the
    // latest. ALL leagues get one at each market's close, counting only that market's symbols.
    // Daily bars then include the new session.
    for (const market of justClosed) {
      closeSnapshotDue.set(market, sessionBounds(market, marketDate(market, now())).close);
    }
    for (const [market, close] of closeSnapshotDue) {
      const leagueIds = activeLeagueIds([market]);
      if (now() >= close + POST_CLOSE_FETCH_MS || leagueIds.every((id) => hasClosingQuotes(id, close, market))) {
        closeSnapshotDue.delete(market);
        for (const id of leagueIds) takeSnapshots(id);
      }
    }
    if (justClosed.length > 0) void dailyBars.run();
  });

  const agents = guarded('agents', () => runDueAgents());

  const every = (ms: number, job: Job) => {
    timers.push(setInterval(() => void job.run(), ms));
  };
  every(config.collectIntervalSec * 1000, collect);
  every(MINUTE_MS, leagues);
  every(MINUTE_MS, agents);
  every(SNAPSHOT_MS, snapshots);

  let stopped = false;
  // First cycle right away: prices for every symbol, then league states, then due agents.
  const ready = (async () => {
    for (const job of [collect, leagues, agents]) {
      if (stopped) return;
      await job.run();
    }
  })();

  return {
    ready,
    async stop(timeoutMs = 10_000) {
      stopped = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      const jobs = [collect, leagues, agents, snapshots, dailyBars];
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([Promise.all([ready, ...jobs.map((j) => j.idle())]), timeout]);
      clearTimeout(timer);
    },
  };
}
