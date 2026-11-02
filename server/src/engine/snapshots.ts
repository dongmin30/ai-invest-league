import type { EquityPoint, EquitySeries } from '../../../shared/api-types';
import { tx } from '../db/db';
import { now } from '../lib/time';
import { getFx } from '../market/fx';
import { equityOf } from './portfolio';
import { computeRankings } from './ranking';
import { getLeagueRow, getParticipantsOf, sql, type LeagueRow } from './store';

const TOP_HUMANS = 10;

/**
 * Records one equity snapshot per (non-left) participant of every active league (or only
 * `leagueId`, if it is active). ALL leagues also record the USD/KRW mid the equity used
 * (`fx_rate`), so a finished league's portfolio is priced at exactly that rate. Returns the
 * number of snapshots written.
 */
export function takeSnapshots(leagueId?: number): number {
  const leagues = (
    leagueId === undefined
      ? sql("SELECT * FROM leagues WHERE status = 'active'").all()
      : sql("SELECT * FROM leagues WHERE id = ? AND status = 'active'").all(leagueId)
  ) as LeagueRow[];
  const ts = now();
  // equityOf marks US holdings at this same in-memory mid (nothing can change it inside this call).
  const mid = getFx()?.rate ?? null;
  return tx(() => {
    let count = 0;
    for (const league of leagues) {
      for (const p of getParticipantsOf(league.id)) {
        if (p.left_at !== null) continue;
        const equity = equityOf(p.id);
        sql(
          'INSERT OR REPLACE INTO snapshots (participant_id, ts, equity, return_rate, fx_rate) VALUES (?, ?, ?, ?, ?)',
        ).run(p.id, ts, equity, equity / league.start_cash - 1, league.market === 'ALL' ? mid : null);
        count++;
      }
    }
    return count;
  });
}

/**
 * Return-rate series for the league chart: the top 10 humans by standing, every AI and the
 * viewer. Each series starts at 0 on start_at; active leagues end with a live point.
 */
export function getEquitySeries(leagueId: number, viewerParticipantId: number | null): EquitySeries[] {
  const league = getLeagueRow(leagueId);
  if (!league) return [];
  const at = now();
  const rankings = computeRankings(leagueId);
  const humans = rankings.filter((r) => r.kind === 'human');
  const shown = rankings.filter(
    (r) => r.kind === 'ai' || humans.indexOf(r) < TOP_HUMANS || r.participant_id === viewerParticipantId,
  );

  return shown.map((r) => {
    const snapshots = sql('SELECT ts, return_rate FROM snapshots WHERE participant_id = ? ORDER BY ts').all(
      r.participant_id,
    ) as EquityPoint[];
    const points: EquityPoint[] = [];
    if (league.start_at <= at && (snapshots.length === 0 || snapshots[0]!.ts > league.start_at)) {
      points.push({ ts: league.start_at, return_rate: 0 });
    }
    points.push(...snapshots);
    const last = points.at(-1);
    if (league.status === 'active' && last && at > last.ts) points.push({ ts: at, return_rate: r.return_rate });
    return { participant_id: r.participant_id, display_name: r.display_name, kind: r.kind, points };
  });
}
