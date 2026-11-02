import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { joinLeague } from '../../src/engine/leagues';
import { matchOrders } from '../../src/engine/matcher';
import { computeRankings, leagueAverages, mddOf } from '../../src/engine/ranking';
import {
  MIN,
  activeLeague,
  buy,
  clockNow,
  feed,
  makeAgent,
  makeUser,
  quote,
  resetEngineState,
  restoreEngineState,
  setClock,
} from './helpers';

const SAMSUNG = '005930';
const HYNIX = '000660';

function tick(...quotes: [string, number][]): void {
  setClock(clockNow() + MIN);
  matchOrders(feed(...quotes.map(([s, p]) => quote(s, p))));
}

function snapshot(participantId: number, ts: number, equity: number, startCash = 10_000_000): void {
  db.prepare('INSERT INTO snapshots (participant_id, ts, equity, return_rate) VALUES (?, ?, ?, ?)').run(
    participantId,
    ts,
    equity,
    equity / startCash - 1,
  );
}

describe('mddOf', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('is the deepest peak-to-trough drop over start cash, snapshots and current equity', () => {
    const { participantId } = activeLeague();
    expect(mddOf(participantId)).toBe(0);
    snapshot(participantId, 1, 11_000_000);
    snapshot(participantId, 2, 9_900_000);
    snapshot(participantId, 3, 10_500_000);
    // current equity is 10,000,000 (all cash)
    expect(mddOf(participantId)).toBeCloseTo(9_900_000 / 11_000_000 - 1, 12);
  });

  it('includes the live equity when it is the new low', () => {
    const { participantId } = activeLeague();
    feed(quote(SAMSUNG, 80_000));
    buy(participantId, SAMSUNG, 50);
    tick([SAMSUNG, 80_000]);
    tick([SAMSUNG, 40_000]);
    // equity = 10,000,000 − 4,000,000 − fee 600 + 50 × 40,000
    expect(mddOf(participantId)).toBeCloseTo(7_999_400 / 10_000_000 - 1, 12);
  });
});

describe('computeRankings (rule 4)', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('ranks eligible participants by return, ineligible last with rank null', () => {
    const { leagueId, participantId: winner } = activeLeague('KR', { owner_id: makeUser('승자') });
    const loser = joinLeague(leagueId, { userId: makeUser('패자') });
    const idle = joinLeague(leagueId, { userId: makeUser('관망') });
    const botId = makeAgent('기준선 봇', { provider: 'rule', model: 'baseline' });
    const bot = joinLeague(leagueId, { agentId: botId });

    feed(quote(SAMSUNG, 80_000), quote(HYNIX, 100_000));
    buy(winner, SAMSUNG, 10);
    buy(loser, HYNIX, 10);
    buy(bot, SAMSUNG, 5);
    tick([SAMSUNG, 80_000], [HYNIX, 100_000]);
    tick([SAMSUNG, 88_000], [HYNIX, 90_000]);

    const rows = computeRankings(leagueId);
    expect(rows.map((r) => [r.participant_id, r.rank, r.eligible])).toEqual([
      [winner, 1, true],
      [bot, 2, true],
      [loser, 3, true],
      [idle, null, false],
    ]);
    const top = rows[0]!;
    expect(top).toMatchObject({ display_name: '승자', kind: 'human', agent_id: null, provider: null, model: null, trade_count: 1 });
    expect(top.equity).toBe(10_000_000 - 800_120 + 880_000);
    expect(top.return_rate).toBeCloseTo(79_880 / 10_000_000, 12);
    expect(rows[1]).toMatchObject({ display_name: '기준선 봇', kind: 'ai', agent_id: botId, provider: 'rule', model: 'baseline' });
    expect(rows[3]).toMatchObject({ equity: 10_000_000, return_rate: 0, trade_count: 0, mdd: 0 });
    expect(rows[2]!.mdd).toBeLessThan(0);
  });

  it('breaks return ties by MDD (closer to 0 first), then by fewer trades', () => {
    const { leagueId, participantId: a } = activeLeague();
    const b = joinLeague(leagueId, { userId: makeUser('B') });
    const c = joinLeague(leagueId, { userId: makeUser('C') });

    feed(quote(SAMSUNG, 80_000));
    buy(a, SAMSUNG, 10); // fee 120
    buy(b, SAMSUNG, 5); // fee 60
    buy(b, SAMSUNG, 5); // fee 60
    buy(c, SAMSUNG, 10); // fee 120
    tick([SAMSUNG, 80_000]);
    snapshot(c, clockNow(), 9_000_000);

    const rows = computeRankings(leagueId);
    expect(rows.map((r) => r.equity)).toEqual([9_999_880, 9_999_880, 9_999_880]);
    expect(rows.map((r) => [r.participant_id, r.rank, r.trade_count])).toEqual([
      [a, 1, 1],
      [b, 2, 2],
      [c, 3, 1],
    ]);
    expect(rows[2]!.mdd).toBeCloseTo(-0.1, 12);
  });

  it('computes human, LLM-agent and baseline averages', () => {
    const { leagueId, participantId: human } = activeLeague();
    const idleHuman = joinLeague(leagueId, { userId: makeUser() });
    const claude = joinLeague(leagueId, { agentId: makeAgent('Claude 트레이더', { provider: 'claude', model: 'claude-opus-5-5' }) });
    const baseline = joinLeague(leagueId, { agentId: makeAgent('기준선 봇', { provider: 'rule', model: 'baseline' }) });
    joinLeague(leagueId, { agentId: makeAgent('모멘텀 봇', { provider: 'rule', model: 'momentum' }) });

    feed(quote(SAMSUNG, 80_000));
    buy(human, SAMSUNG, 10);
    buy(claude, SAMSUNG, 20);
    buy(baseline, SAMSUNG, 30);
    tick([SAMSUNG, 80_000]);
    tick([SAMSUNG, 90_000]);

    const ret = (pid: number) => computeRankings(leagueId).find((r) => r.participant_id === pid)!.return_rate;
    const avg = leagueAverages(leagueId);
    expect(avg.human_avg_return).toBeCloseTo((ret(human) + ret(idleHuman)) / 2, 12);
    expect(avg.ai_avg_return).toBeCloseTo(ret(claude), 12);
    expect(avg.baseline_return).toBeCloseTo(ret(baseline), 12);
  });

  it('returns nulls when a kind is missing', () => {
    const { leagueId } = activeLeague();
    expect(leagueAverages(leagueId)).toEqual({ human_avg_return: 0, ai_avg_return: null, baseline_return: null });
    expect(computeRankings(424242)).toEqual([]);
  });
});
