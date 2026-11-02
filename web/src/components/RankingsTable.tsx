import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Currency, LeagueDetail, RankingRow } from '@shared/api-types';
import { api } from '../api/client';
import { useApi } from '../hooks/useApi';
import { formatMoney } from '../lib/format';
import { KindBadge } from './league';
import { HoldingsTable } from './PortfolioPanels';
import { cx, EmptyState, ErrorState, Loading, RateText } from './ui';

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

/** One participant's holdings, loaded when their ranking row is expanded. */
function ParticipantHoldings({ participantId }: { participantId: number }) {
  const portfolio = useApi(() => api.portfolio(participantId), [participantId]);
  if (portfolio.loading) return <Loading label="보유 종목 불러오는 중…" />;
  if (portfolio.error) return <ErrorState error={portfolio.error} onRetry={() => portfolio.reload()} />;
  const p = portfolio.data;
  if (!p) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 text-xs text-slate-500 dark:text-slate-400">
        <span>현금 {formatMoney(p.currency, p.cash)}</span>
        <span>주식 평가 {formatMoney(p.currency, p.holdings.reduce((s, h) => s + h.value, 0))}</span>
        <span>보유 {p.holdings.length}종목</span>
      </div>
      <HoldingsTable holdings={p.holdings} currency={p.currency} />
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
  const [open, setOpen] = useState<number | null>(null);
  if (rows.length === 0) return <EmptyState>아직 참가자가 없습니다.</EmptyState>;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[38rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-700 text-left text-xs text-slate-500 dark:text-slate-400">
            <th className="w-12 px-4 py-2 font-medium">순위</th>
            <th className="px-2 py-2 font-medium">참가자</th>
            <th className="px-2 py-2 text-right font-medium">평가금액</th>
            <th className="px-2 py-2 text-right font-medium">수익률</th>
            <th className="px-2 py-2 text-right font-medium">MDD</th>
            <th className="px-2 py-2 text-right font-medium">거래</th>
            <th className="px-4 py-2 text-right font-medium">
              <span className="sr-only">보유 종목</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isMe = row.participant_id === myParticipantId;
            const expanded = open === row.participant_id;
            return (
              <Fragment key={row.participant_id}>
              <tr className={cx('border-b border-slate-100 dark:border-slate-700/60 last:border-0', isMe && 'bg-amber-50 dark:bg-amber-950/40', !row.eligible && 'text-slate-500 dark:text-slate-400')}>
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
                <td className="px-2 py-2.5 text-right tabular-nums">{row.trade_count}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    type="button"
                    className="whitespace-nowrap rounded-md border border-slate-300 dark:border-slate-600 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : row.participant_id)}
                  >
                    보유 종목 {expanded ? '▴' : '▾'}
                  </button>
                </td>
              </tr>
              {expanded && (
                <tr className="border-b border-slate-100 dark:border-slate-700/60 bg-slate-50/60 dark:bg-slate-900/40">
                  <td colSpan={7} className="px-4 py-3">
                    <ParticipantHoldings participantId={row.participant_id} />
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
