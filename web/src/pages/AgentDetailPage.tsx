import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { DecisionLog, DecisionResult } from '@shared/api-types';
import { api, ApiError, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AgentStatus, ProviderBadge } from '../components/agent';
import { DecisionTimeline } from '../components/DecisionTimeline';
import { Alert, Badge, btn, Card, cx, EmptyState, ErrorState, inputClass, Loading, RateText } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { MARKET_LABEL } from '../lib/format';

// btn.small with the colours swapped; a separate class list because Tailwind does not let a later class win.
const ACTIVE_CHIP =
  'inline-flex items-center justify-center rounded-md border border-slate-900 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900';

const RESULT_FILTERS: { value: DecisionResult | null; label: string }[] = [
  { value: null, label: '전체' },
  { value: 'traded', label: '매매' },
  { value: 'hold', label: '관망' },
  { value: 'failed', label: '거부·오류' },
];

export default function AgentDetailPage() {
  const agentId = Number(useParams().id);
  const { user } = useAuth();
  const detail = useApi(() => api.agent(agentId), [agentId]);

  // The league filter lives in the URL (?league=3) so league pages can link straight to it.
  const [search, setSearch] = useSearchParams();
  const leagueParam = Number(search.get('league'));
  const leagueFilter = Number.isInteger(leagueParam) && leagueParam > 0 ? leagueParam : null;
  const [result, setResult] = useState<DecisionResult | null>(null);
  const query = { league_id: leagueFilter ?? undefined, result: result ?? undefined };
  const firstPage = useApi(() => api.agentDecisions(agentId, query), [agentId, leagueFilter, result]);
  const [older, setOlder] = useState<{ logs: DecisionLog[]; next: number | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const firstPageRef = useRef(firstPage.data);
  firstPageRef.current = firstPage.data;
  // A new first page (filter change or refresh) starts the list over.
  useEffect(() => {
    setOlder(null);
    setMoreError(null);
  }, [firstPage.data]);
  const [running, setRunning] = useState<number | null>(null);
  const [runMsg, setRunMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const leagueNames = useMemo(
    () => new Map((detail.data?.participations ?? []).map((p) => [p.league_id, p.league_name])),
    [detail.data],
  );

  if (!Number.isFinite(agentId)) return <ErrorState error={new ApiError(404, 'not_found', '잘못된 에이전트 주소입니다.')} />;
  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error || !detail.data) return <ErrorState error={detail.error} onRetry={() => detail.reload()} />;

  const { agent, participations } = detail.data;
  const logs = [...(firstPage.data?.decisions ?? []), ...(older?.logs ?? [])];
  const nextBefore = older ? older.next : (firstPage.data?.next_before ?? null);
  const total = firstPage.data?.total ?? 0;

  const pickLeague = (leagueId: number | null) => {
    const next = new URLSearchParams(search);
    if (leagueId === null) next.delete('league');
    else next.set('league', String(leagueId));
    setSearch(next, { replace: true });
  };

  const loadMore = async () => {
    if (nextBefore === null) return;
    const page = firstPage.data;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const more = await api.agentDecisions(agentId, { ...query, before: nextBefore });
      // Dropped when the filters changed while this page was loading.
      setOlder((prev) => (firstPageRef.current === page ? { logs: [...(prev?.logs ?? []), ...more.decisions], next: more.next_before } : prev));
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const runNow = async (leagueId: number) => {
    setRunning(leagueId);
    setRunMsg(null);
    try {
      const log = await api.adminRunAgent(agent.id, leagueId);
      setRunMsg({ tone: 'success', text: `판단 완료: ${log.status} (${(log.latency_ms / 1000).toFixed(1)}초)` });
      detail.reload({ silent: true });
      firstPage.reload({ silent: true });
    } catch (err) {
      setRunMsg({ tone: 'error', text: errorMessage(err) });
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link to="/agents" className="text-xs text-slate-500 dark:text-slate-400 hover:underline">
          ← 에이전트 목록
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{agent.name}</h1>
          <ProviderBadge agent={agent} />
          <AgentStatus agent={agent} />
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          모델 <span className="font-medium text-slate-700 dark:text-slate-200">{agent.model}</span> · 시장 {agent.markets.map((m) => MARKET_LABEL[m]).join(', ')}
        </p>
        {agent.description && <p className="text-sm text-slate-600 dark:text-slate-300">{agent.description}</p>}
      </div>

      {runMsg && <Alert tone={runMsg.tone}>{runMsg.text}</Alert>}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="참가 리그" className="lg:col-span-1">
          {participations.length === 0 ? (
            <EmptyState>참가 중인 리그가 없습니다.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-700/60">
              {participations.map((p) => (
                <li
                  key={p.participant_id}
                  className={cx('flex items-center justify-between gap-2 py-2 text-sm', leagueFilter === p.league_id && '-mx-2 rounded-md bg-slate-50 px-2 dark:bg-slate-700/40')}
                >
                  <div className="min-w-0">
                    <Link to={`/leagues/${p.league_id}`} className="block truncate font-medium hover:underline">
                      {p.league_name}
                    </Link>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{p.rank !== null ? `${p.rank}위` : '미집계'}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RateText value={p.return_rate} className="font-semibold" />
                    <button
                      type="button"
                      className={btn.small}
                      aria-pressed={leagueFilter === p.league_id}
                      onClick={() => {
                        pickLeague(leagueFilter === p.league_id ? null : p.league_id);
                        // On narrow screens the history sits below this list.
                        historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                    >
                      {leagueFilter === p.league_id ? '전체 보기' : '판단 보기'}
                    </button>
                    {user?.role === 'admin' && agent.enabled && (
                      <button type="button" className={btn.small} disabled={running !== null} onClick={() => runNow(p.league_id)}>
                        {running === p.league_id ? '실행 중…' : '지금 판단'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div ref={historyRef} className="scroll-mt-4 lg:col-span-2">
        <Card
          title="판단 기록"
          actions={<Badge>{firstPage.data ? `${total}건 중 ${logs.length}건` : '불러오는 중'}</Badge>}
        >
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="decision-league">리그</label>
            <select
              id="decision-league"
              className={cx(inputClass, 'w-auto max-w-full py-1.5')}
              value={leagueFilter ?? ''}
              onChange={(e) => pickLeague(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">모든 리그</option>
              {leagueFilter !== null && !leagueNames.has(leagueFilter) && <option value={leagueFilter}>리그 #{leagueFilter}</option>}
              {participations.map((p) => (
                <option key={p.participant_id} value={p.league_id}>
                  {p.league_name}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap gap-1" role="group" aria-label="판단 결과">
              {RESULT_FILTERS.map((f) => (
                <button
                  key={f.label}
                  type="button"
                  aria-pressed={result === f.value}
                  className={result === f.value ? ACTIVE_CHIP : btn.small}
                  onClick={() => setResult(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {firstPage.loading && !firstPage.data ? (
            <Loading />
          ) : firstPage.error || !firstPage.data ? (
            <ErrorState error={firstPage.error} onRetry={() => firstPage.reload()} />
          ) : (
            <>
              <DecisionTimeline logs={logs} leagueNames={leagueNames} filtered={leagueFilter !== null || result !== null} />
              {moreError && <div className="mt-3"><Alert tone="error">{moreError}</Alert></div>}
              {nextBefore !== null && (
                <div className="mt-4 text-center">
                  <button type="button" className={btn.small} disabled={loadingMore} onClick={loadMore}>
                    {loadingMore ? '불러오는 중…' : '이전 기록 더 보기'}
                  </button>
                </div>
              )}
            </>
          )}
        </Card>
        </div>
      </div>
    </div>
  );
}
