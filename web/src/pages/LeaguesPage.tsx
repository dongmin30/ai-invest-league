import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { LeagueMarket, LeagueStatus, LeagueSummary } from '@shared/api-types';
import { api } from '../api/client';
import CreateLeagueModal from '../components/CreateLeagueModal';
import { JoinByCodeForm } from '../components/Invite';
import { JoinLeague } from '../components/JoinLeague';
import { LeagueCountdown, LeagueMetaBadges } from '../components/league';
import { btn, cx, EmptyState, ErrorState, Loading } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { formatDateTime, formatMoney, LEAGUE_STATUS_LABEL, MARKET_LABEL } from '../lib/format';

const TABS: LeagueStatus[] = ['recruiting', 'active', 'finished'];
// `undefined` = no market filter; 'ALL' is a real league market (통합) and is sent as market=ALL.
const MARKET_FILTERS: { value: LeagueMarket | undefined; label: string }[] = [
  { value: undefined, label: '전체' },
  { value: 'KR', label: '국내 KR' },
  { value: 'US', label: '미국 US' },
  { value: 'ALL', label: '통합 KR+US' },
];

function parseMarket(value: string | null): LeagueMarket | undefined {
  return value === 'KR' || value === 'US' || value === 'ALL' ? value : undefined;
}

function LeagueRow({ league, onJoined }: { league: LeagueSummary; onJoined: (league: LeagueSummary, participantId: number) => void }) {
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <Link to={`/leagues/${league.id}`} className="block truncate text-base font-semibold hover:underline">
          {league.name}
        </Link>
        <LeagueMetaBadges league={league} />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>
            {formatDateTime(league.start_at)} ~ {formatDateTime(league.end_at)}
          </span>
          <span>시작 자금 {formatMoney(league.currency, league.start_cash)}</span>
          <span>
            참가 {league.participant_count}명 (AI {league.ai_count})
          </span>
          <span>하루 주문 {league.max_orders_per_day}회</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 sm:flex-col sm:items-end">
        <span className="text-xs">
          <LeagueCountdown league={league} />
        </span>
        <div className="flex items-center gap-2">
          <JoinLeague league={league} compact onJoined={(pid) => onJoined(league, pid)} />
          {league.joined && league.status === 'active' && (
            <Link to={`/leagues/${league.id}/trade`} className={btn.small}>
              매매
            </Link>
          )}
          <Link to={`/leagues/${league.id}`} className={btn.small}>
            상세
          </Link>
        </div>
      </div>
    </li>
  );
}

export default function LeaguesPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const status = (TABS as string[]).includes(params.get('status') ?? '') ? (params.get('status') as LeagueStatus) : 'recruiting';
  const market = parseMarket(params.get('market'));

  const leagues = useApi(() => api.listLeagues({ status, market }), [status, market]);

  const setFilter = (key: 'status' | 'market', value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const markJoined = (league: LeagueSummary, participantId: number) => {
    leagues.setData((list) =>
      list?.map((l) =>
        l.id === league.id ? { ...l, joined: true, my_participant_id: participantId, participant_count: l.participant_count + 1 } : l,
      ),
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">리그</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">공식 리그(3일 · 1주 · 1개월)와 커스텀 리그에 참가해 AI와 겨뤄 보세요.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <JoinByCodeForm onJoined={(leagueId) => navigate(`/leagues/${leagueId}`)} />
          <button type="button" className={cx(btn.primary, 'h-10 whitespace-nowrap')} onClick={() => setCreating(true)}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
              <path d="M10 4.5v11M4.5 10h11" strokeLinecap="round" />
            </svg>
            커스텀 리그 만들기
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-700 p-1" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={status === tab}
              onClick={() => setFilter('status', tab)}
              className={cx(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                status === tab ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-600 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100',
              )}
            >
              {LEAGUE_STATUS_LABEL[tab]}
            </button>
          ))}
        </div>
        <div className="inline-flex flex-wrap gap-1" role="group" aria-label="시장">
          {MARKET_FILTERS.map(({ value: m, label }) => {
            const active = m === market;
            return (
              <button
                key={m ?? 'any'}
                type="button"
                onClick={() => setFilter('market', m)}
                className={cx(
                  'rounded-full border px-3 py-1 text-xs font-medium',
                  active ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50',
                )}
                aria-pressed={active}
              >
                {m === 'ALL' && (
                  <span
                    className={cx('mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle', active ? 'bg-violet-300 dark:bg-violet-600' : 'bg-violet-500 dark:bg-violet-400')}
                    aria-hidden="true"
                  />
                )}
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm">
        {leagues.loading ? (
          <Loading />
        ) : leagues.error ? (
          <div className="p-4">
            <ErrorState error={leagues.error} onRetry={() => leagues.reload()} />
          </div>
        ) : !leagues.data || leagues.data.length === 0 ? (
          <EmptyState>
            {LEAGUE_STATUS_LABEL[status]} {market ? `${MARKET_LABEL[market]} ` : ''}리그가 없습니다.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-700/60">
            {leagues.data.map((league) => (
              <LeagueRow key={league.id} league={league} onJoined={markJoined} />
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <CreateLeagueModal
          onClose={() => setCreating(false)}
          onCreated={(league) => {
            setCreating(false);
            navigate(`/leagues/${league.id}`);
          }}
        />
      )}
    </div>
  );
}
