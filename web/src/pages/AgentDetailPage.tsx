import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AgentStatus, ProviderBadge } from '../components/agent';
import { DecisionTimeline } from '../components/DecisionTimeline';
import { Alert, Badge, btn, Card, EmptyState, ErrorState, Loading, RateText } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { MARKET_LABEL } from '../lib/format';

export default function AgentDetailPage() {
  const agentId = Number(useParams().id);
  const { user } = useAuth();
  const detail = useApi(() => api.agent(agentId), [agentId]);
  const [running, setRunning] = useState<number | null>(null);
  const [runMsg, setRunMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const leagueNames = useMemo(
    () => new Map((detail.data?.participations ?? []).map((p) => [p.league_id, p.league_name])),
    [detail.data],
  );

  if (!Number.isFinite(agentId)) return <ErrorState error={new ApiError(404, 'not_found', '잘못된 에이전트 주소입니다.')} />;
  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error || !detail.data) return <ErrorState error={detail.error} onRetry={() => detail.reload()} />;

  const { agent, participations, recent_decisions } = detail.data;

  const runNow = async (leagueId: number) => {
    setRunning(leagueId);
    setRunMsg(null);
    try {
      const log = await api.adminRunAgent(agent.id, leagueId);
      setRunMsg({ tone: 'success', text: `판단 완료: ${log.status} (${(log.latency_ms / 1000).toFixed(1)}초)` });
      detail.reload({ silent: true });
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
                <li key={p.participant_id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <Link to={`/leagues/${p.league_id}`} className="block truncate font-medium hover:underline">
                      {p.league_name}
                    </Link>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{p.rank !== null ? `${p.rank}위` : '미집계'}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RateText value={p.return_rate} className="font-semibold" />
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

        <Card
          title="판단 기록"
          className="lg:col-span-2"
          actions={<Badge>최근 {recent_decisions.length}건</Badge>}
        >
          <DecisionTimeline logs={recent_decisions} leagueNames={leagueNames} />
        </Card>
      </div>
    </div>
  );
}
