import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { AgentStatus, ProviderBadge } from '../components/agent';
import { Badge, EmptyState, ErrorState, Loading } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { MARKET_LABEL } from '../lib/format';

export default function AgentsPage() {
  const agents = useApi(() => api.agents(), []);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">AI 에이전트</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          모든 에이전트는 같은 후보 종목, 같은 수수료·세금·주문 한도 규칙으로 판단합니다. 판단 근거와 결과는 전부 공개됩니다.
        </p>
      </div>
      {agents.loading ? (
        <Loading />
      ) : agents.error ? (
        <ErrorState error={agents.error} onRetry={() => agents.reload()} />
      ) : !agents.data || agents.data.length === 0 ? (
        <EmptyState>등록된 에이전트가 없습니다.</EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {agents.data.map((agent) => (
            <Link
              key={agent.id}
              to={`/agents/${agent.id}`}
              className="flex flex-col gap-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-sm transition hover:border-slate-300 dark:hover:border-slate-600 hover:shadow"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold">{agent.name}</div>
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">{agent.model}</div>
                </div>
                <ProviderBadge agent={agent} />
              </div>
              {agent.description && <p className="text-sm text-slate-600 dark:text-slate-300">{agent.description}</p>}
              <div className="mt-auto flex flex-wrap items-center gap-1.5">
                <AgentStatus agent={agent} />
                {agent.markets.map((m) => (
                  <Badge key={m}>{MARKET_LABEL[m]}</Badge>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
