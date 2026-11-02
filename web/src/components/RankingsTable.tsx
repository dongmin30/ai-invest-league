import { Link } from 'react-router-dom';
import type { Currency, LeagueDetail, RankingRow } from '@shared/api-types';
import { formatMoney } from '../lib/format';
import { KindBadge } from './league';
import { cx, EmptyState, RateText } from './ui';

export function AveragesStrip({ detail }: { detail: LeagueDetail }) {
  const items = [
    { label: '인간 평균', value: detail.human_avg_return, hint: '사람 참가자' },
    { label: 'AI 평균', value: detail.ai_avg_return, hint: 'LLM 에이전트' },
    { label: '기준선 봇', value: detail.baseline_return, hint: '균등 매수 후 보유' },
  ];
  return (
    <div className="grid grid-cols-3 divide-x divide-slate-100 dark:divide-slate-700/60 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm">
      {items.map((item) => (
        <div key={item.label} className="px-3 py-3 sm:px-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">{item.label}</div>
          <RateText value={item.value} className="text-lg font-semibold sm:text-xl" />
          <div className="hidden text-xs text-slate-400 sm:block">{item.hint}</div>
        </div>
      ))}
    </div>
  );
}

function RankCell({ row }: { row: RankingRow }) {
  if (row.rank === null) return <span className="whitespace-nowrap text-xs text-slate-400" title="체결된 거래가 1건 이상이어야 순위에 오릅니다">미집계</span>;
  const medal = row.rank <= 3 ? ['bg-amber-400', 'bg-slate-400', 'bg-orange-400'][row.rank - 1] : null;
  return medal ? (
    <span className={cx('inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white', medal)}>{row.rank}</span>
  ) : (
    <span className="inline-flex h-6 w-6 items-center justify-center text-sm font-semibold">{row.rank}</span>
  );
}

export function RankingsTable({ rows, currency, myParticipantId }: {
  rows: RankingRow[];
  currency: Currency;
  myParticipantId: number | null;
}) {
  if (rows.length === 0) return <EmptyState>아직 참가자가 없습니다.</EmptyState>;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-700 text-left text-xs text-slate-500 dark:text-slate-400">
            <th className="w-12 px-4 py-2 font-medium">순위</th>
            <th className="px-2 py-2 font-medium">참가자</th>
            <th className="px-2 py-2 text-right font-medium">평가금액</th>
            <th className="px-2 py-2 text-right font-medium">수익률</th>
            <th className="px-2 py-2 text-right font-medium">MDD</th>
            <th className="px-4 py-2 text-right font-medium">거래</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isMe = row.participant_id === myParticipantId;
            return (
              <tr key={row.participant_id} className={cx('border-b border-slate-100 dark:border-slate-700/60 last:border-0', isMe && 'bg-amber-50 dark:bg-amber-950/40', !row.eligible && 'text-slate-500 dark:text-slate-400')}>
                <td className="px-4 py-2.5">
                  <RankCell row={row} />
                </td>
                <td className="px-2 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {row.kind === 'ai' && row.agent_id !== null ? (
                      <Link to={`/agents/${row.agent_id}`} className="font-medium hover:underline">
                        {row.display_name}
                      </Link>
                    ) : (
                      <span className="font-medium">{row.display_name}</span>
                    )}
                    {isMe && <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">나</span>}
                    <KindBadge kind={row.kind} provider={row.provider} model={row.model} />
                  </div>
                </td>
                <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">{formatMoney(currency, row.equity)}</td>
                <td className="whitespace-nowrap px-2 py-2.5 text-right">
                  <RateText value={row.return_rate} className="font-semibold" />
                </td>
                <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{(row.mdd * 100).toFixed(2)}%</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{row.trade_count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
