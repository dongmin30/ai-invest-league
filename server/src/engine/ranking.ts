import type { AgentProvider, RankingRow } from '../../../shared/api-types';
import { equityOf } from './portfolio';
import { getLeagueRow, getParticipantRow, lastSnapshot, sql, type LeagueRow } from './store';

interface RankedParticipant {
  id: number;
  user_id: number | null;
  agent_id: number | null;
  nickname: string | null;
  agent_name: string | null;
  provider: AgentProvider | null;
  model: string | null;
  trade_count: number;
}

/**
 * Equity used for standings. Finished leagues are frozen at the final snapshot so later
 * price moves do not reshuffle them.
 */
function standingEquity(league: LeagueRow, participantId: number): number {
  if (league.status === 'finished') return lastSnapshot(participantId)?.equity ?? equityOf(participantId);
  return equityOf(participantId);
}

/**
 * Maximum drawdown as a fraction ≤ 0, over start cash → snapshots → current equity
 * (current equity is left out once the league is finished).
 */
export function mddOf(participantId: number): number {
  const participant = getParticipantRow(participantId);
  const league = participant && getLeagueRow(participant.league_id);
  if (!participant || !league) return 0;
  const series = [
    league.start_cash,
    ...(sql('SELECT equity FROM snapshots WHERE participant_id = ? ORDER BY ts').pluck().all(participantId) as number[]),
  ];
  if (league.status !== 'finished') series.push(equityOf(participantId));
  let peak = -Infinity;
  let mdd = 0;
  for (const v of series) {
    peak = Math.max(peak, v);
    if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd === 0 ? 0 : mdd;
}

function compareEligible(a: RankingRow, b: RankingRow): number {
  return b.return_rate - a.return_rate || b.mdd - a.mdd || a.trade_count - b.trade_count || a.participant_id - b.participant_id;
}

/**
 * Participants who left the league (forfeit) are not listed.
 * Eligible participants (≥ 1 filled order) ranked by return desc, MDD desc (closer to 0
 * first), trade count asc. Ineligible participants follow with `rank: null`.
 */
export function computeRankings(leagueId: number): RankingRow[] {
  const league = getLeagueRow(leagueId);
  if (!league) return [];
  const participants = sql(
    `SELECT p.id, p.user_id, p.agent_id, u.nickname, a.name AS agent_name, a.provider, a.model,
            (SELECT COUNT(*) FROM orders o WHERE o.participant_id = p.id AND o.status = 'filled') AS trade_count
     FROM participants p
     LEFT JOIN users u ON u.id = p.user_id
     LEFT JOIN agents a ON a.id = p.agent_id
     WHERE p.league_id = ? AND p.left_at IS NULL
     ORDER BY p.id`,
  ).all(leagueId) as RankedParticipant[];

  const rows: RankingRow[] = participants.map((p) => {
    const equity = standingEquity(league, p.id);
    const isAi = p.agent_id !== null;
    return {
      participant_id: p.id,
      rank: null,
      display_name: (isAi ? p.agent_name : p.nickname) ?? `참가자 ${p.id}`,
      kind: isAi ? 'ai' : 'human',
      agent_id: p.agent_id,
      provider: isAi ? p.provider : null,
      model: isAi ? p.model : null,
      equity,
      return_rate: equity / league.start_cash - 1,
      mdd: mddOf(p.id),
      trade_count: p.trade_count,
      eligible: p.trade_count > 0,
    };
  });

  const eligible = rows.filter((r) => r.eligible).sort(compareEligible);
  eligible.forEach((r, i) => {
    r.rank = i + 1;
  });
  const ineligible = rows.filter((r) => !r.eligible).sort((a, b) => a.participant_id - b.participant_id);
  return [...eligible, ...ineligible];
}

export interface LeagueAverages {
  human_avg_return: number | null;
  /** LLM agents only (provider !== 'rule'). */
  ai_avg_return: number | null;
  /** The rule:baseline agent, when it participates. */
  baseline_return: number | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Averages over every participant of each kind; pass `rankings` to reuse a computed table. */
export function leagueAverages(leagueId: number, rankings: RankingRow[] = computeRankings(leagueId)): LeagueAverages {
  const baseline = rankings.find((r) => r.provider === 'rule' && r.model === 'baseline');
  return {
    human_avg_return: mean(rankings.filter((r) => r.kind === 'human').map((r) => r.return_rate)),
    ai_avg_return: mean(rankings.filter((r) => r.kind === 'ai' && r.provider !== 'rule').map((r) => r.return_rate)),
    baseline_return: baseline ? baseline.return_rate : null,
  };
}
