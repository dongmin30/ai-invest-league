import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { createLeague, joinLeague } from '../../src/engine/leagues';
import { getEquitySeries, takeSnapshots } from '../../src/engine/snapshots';
import {
  HOUR,
  KR_OPEN,
  activeLeague,
  clockNow,
  makeAgent,
  makeUser,
  resetEngineState,
  restoreEngineState,
  setClock,
} from './helpers';

describe('snapshots', () => {
  beforeEach(() => resetEngineState());
  afterEach(() => restoreEngineState());

  it('snapshots every participant of active leagues only', () => {
    const { leagueId, participantId } = activeLeague();
    joinLeague(leagueId, { agentId: makeAgent('봇') });
    createLeague({
      name: '예정',
      market: 'KR',
      type: 'custom',
      duration_days: 1,
      is_public: true,
      owner_id: makeUser(),
      start_at: KR_OPEN + 48 * HOUR,
    });

    expect(takeSnapshots()).toBe(2);
    const row = db.prepare('SELECT * FROM snapshots WHERE participant_id = ?').get(participantId);
    expect(row).toEqual({ participant_id: participantId, ts: clockNow(), equity: 10_000_000, return_rate: 0, fx_rate: null });
    expect(takeSnapshots(424242)).toBe(0);
  });

  it('builds series that start at 0 on start_at and end with a live point', () => {
    const { leagueId, participantId } = activeLeague();
    takeSnapshots(leagueId);
    const snapAt = clockNow();
    setClock(snapAt + HOUR);

    const [series] = getEquitySeries(leagueId, participantId);
    expect(series).toMatchObject({ participant_id: participantId, kind: 'human', display_name: 'owner' });
    expect(series!.points).toEqual([
      { ts: KR_OPEN, return_rate: 0 },
      { ts: snapAt, return_rate: 0 },
      { ts: snapAt + HOUR, return_rate: 0 },
    ]);
  });

  it('shows the top 10 humans, every AI and the viewer', () => {
    const { leagueId } = activeLeague();
    const humans = Array.from({ length: 11 }, () => joinLeague(leagueId, { userId: makeUser() }));
    const agents = [makeAgent('A1'), makeAgent('A2')].map((id) => joinLeague(leagueId, { agentId: id }));
    const viewer = humans.at(-1)!;

    const anonymous = getEquitySeries(leagueId, null);
    expect(anonymous.filter((s) => s.kind === 'human')).toHaveLength(10);
    expect(anonymous.filter((s) => s.kind === 'ai').map((s) => s.participant_id)).toEqual(agents);
    expect(anonymous.some((s) => s.participant_id === viewer)).toBe(false);

    const mine = getEquitySeries(leagueId, viewer);
    expect(mine.filter((s) => s.kind === 'human')).toHaveLength(11);
    expect(mine.some((s) => s.participant_id === viewer)).toBe(true);
  });
});
