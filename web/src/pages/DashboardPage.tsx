import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardCard } from '@shared/api-types';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Countdown, LeagueMetaBadges } from '../components/league';
import { LeaveLeague } from '../components/LeaveLeague';
import { btn, EmptyState, ErrorState, Loading, RateText, Stat } from '../components/ui';
import { useApi } from '../hooks/useApi';

const REFRESH_MS = 60_000;

function LeagueCard({ card, fetchedAt, onLeft }: { card: DashboardCard; fetchedAt: number; onLeft: () => void }) {
  const { league } = card;
  const target = fetchedAt + card.remaining_ms;
  return (
    <article className="flex flex-col rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/leagues/${league.id}`} className="min-w-0 text-base font-semibold hover:underline">
          <span className="block truncate">{league.name}</span>
        </Link>
        <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
          {league.status === 'finished' ? '종료' : <Countdown target={target} prefix={league.status === 'recruiting' ? '시작' : '종료'} />}
        </span>
      </div>
      <div className="mt-2">
        <LeagueMetaBadges league={league} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Stat label="내 순위">{card.my_rank !== null ? `${card.my_rank}위` : '-'}</Stat>
        <Stat label="내 수익률">
          <RateText value={card.my_return_rate} />
        </Stat>
        <Stat label="참가자">{card.participant_count}명</Stat>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-slate-50 dark:bg-slate-700/40 p-3 text-sm sm:grid-cols-3">
        <div>
          <div className="text-xs text-slate-500 dark:text-slate-400">인간 평균</div>
          <RateText value={card.human_avg_return} className="font-medium" />
        </div>
        <div>
          <div className="text-xs text-slate-500 dark:text-slate-400">AI 평균</div>
          <RateText value={card.ai_avg_return} className="font-medium" />
        </div>
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <div className="text-xs text-slate-500 dark:text-slate-400">최고 AI</div>
          {card.best_ai_name ? (
            <div className="truncate">
              <span className="mr-1 font-medium">{card.best_ai_name}</span>
              <RateText value={card.best_ai_return} />
            </div>
          ) : (
            <span className="text-slate-400">-</span>
          )}
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <Link to={`/leagues/${league.id}`} className={`${btn.secondary} flex-1`}>
          랭킹 보기
        </Link>
        {league.status === 'active' && league.my_participant_id !== null && (
          <Link to={`/leagues/${league.id}/trade`} className={`${btn.primary} flex-1`}>
            매매하기
          </Link>
        )}
      </div>
      <div className="mt-2 flex justify-end">
        <LeaveLeague league={league} onLeft={onLeft} compact />
      </div>
    </article>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const cards = useApi(async () => {
    const result = await api.dashboard();
    setFetchedAt(Date.now());
    return result;
  }, []);

  const { reload } = cards;
  useEffect(() => {
    const id = window.setInterval(() => reload({ silent: true }), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  const sorted = useMemo(() => {
    const order = { active: 0, recruiting: 1, finished: 2 } as const;
    return [...(cards.data ?? [])].sort((a, b) => order[a.league.status] - order[b.league.status] || a.league.end_at - b.league.end_at);
  }, [cards.data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">안녕하세요, {user?.nickname}님</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">참가 중인 리그의 순위와 AI 대비 성과를 한눈에 확인하세요.</p>
        </div>
        <Link to="/leagues" className={btn.primary}>
          리그 둘러보기
        </Link>
      </div>

      {cards.loading && !cards.data ? (
        <Loading />
      ) : cards.error ? (
        <ErrorState error={cards.error} onRetry={() => cards.reload()} />
      ) : sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800">
          <EmptyState>
            <p>아직 참가한 리그가 없습니다.</p>
            <Link to="/leagues" className={`${btn.primary} mt-4`}>
              리그에 참가하기
            </Link>
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sorted.map((card) => (
            <LeagueCard key={card.league.id} card={card} fetchedAt={fetchedAt} onLeft={() => reload({ silent: true })} />
          ))}
        </div>
      )}
    </div>
  );
}
