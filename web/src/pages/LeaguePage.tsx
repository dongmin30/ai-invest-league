import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { StreamEvent } from '@shared/api-types';
import { api, ApiError, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { FxBadge } from '../components/FxBadge';
import { InviteCodePanel, JoinByCodeForm } from '../components/Invite';
import { JoinLeague } from '../components/JoinLeague';
import { LeaveLeague } from '../components/LeaveLeague';
import { LeagueCountdown, LeagueMetaBadges } from '../components/league';
import { AveragesStrip, RankingsTable } from '../components/RankingsTable';
import { Alert, btn, Card, EmptyState, ErrorState, Loading, RateText, Stat } from '../components/ui';
import { DecisionStatusChip } from '../components/DecisionTimeline';
import { useApi } from '../hooks/useApi';
import { useFx } from '../hooks/useFx';
import { useLeagueStream } from '../hooks/useLeagueStream';
import { formatDateTime, formatMoney, formatTime } from '../lib/format';
import { usePriceInfo } from '../lib/PriceInfoContext';
import { StreamIndicator } from '../components/StreamIndicator';

const EquityChart = lazy(() => import('../components/EquityChart'));

const EQUITY_REFRESH_MS = 120_000;
const MAX_ACTIVITY = 20;

type DecisionEvent = Extract<StreamEvent, { type: 'decision' }> & { at: number };

export default function LeaguePage() {
  const leagueId = Number(useParams().id);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { reportQuotes } = usePriceInfo();
  const detail = useApi(() => api.league(leagueId), [leagueId]);
  const equity = useApi(() => api.leagueEquity(leagueId), [leagueId]);
  const [activity, setActivity] = useState<DecisionEvent[]>([]);
  const [adminMsg, setAdminMsg] = useState<string | null>(null);
  const reloadTimer = useRef<number | undefined>(undefined);

  const { reload: reloadDetail, setData: setDetail } = detail;
  const { reload: reloadEquity } = equity;
  const unified = detail.data?.league.market === 'ALL';
  const { fx, push: pushFx } = useFx(unified);

  useEffect(() => {
    const id = window.setInterval(() => reloadEquity({ silent: true }), EQUITY_REFRESH_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(reloadTimer.current);
    };
  }, [reloadEquity]);

  const onEvent = useCallback(
    (event: StreamEvent) => {
      if (event.type === 'quotes') {
        reportQuotes(event.quotes);
        return;
      }
      if (event.type === 'rankings' && event.league_id === leagueId) {
        setDetail((d) => (d ? { ...d, rankings: event.rankings } : d));
        // Averages are computed server-side; refresh them shortly after a rankings push.
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = window.setTimeout(() => reloadDetail({ silent: true }), 1500);
      }
      if (event.type === 'decision' && event.league_id === leagueId) {
        setActivity((list) => [{ ...event, at: Date.now() }, ...list].slice(0, MAX_ACTIVITY));
      }
      if (event.type === 'fx') pushFx(event.fx);
    },
    [leagueId, reportQuotes, reloadDetail, setDetail, pushFx],
  );
  // Without a live stream, refetch rankings (and averages) instead of waiting for pushes.
  const onPoll = useCallback(() => reloadDetail({ silent: true }), [reloadDetail]);
  const streamState = useLeagueStream(Number.isFinite(leagueId) ? leagueId : null, onEvent, onPoll);

  if (!Number.isFinite(leagueId)) return <ErrorState error={new ApiError(404, 'not_found', '잘못된 리그 주소입니다.')} />;
  if (detail.loading && !detail.data) return <Loading />;
  const invite = params.get('invite');
  // Private leagues are hidden from outsiders, so an invite link joins by code before the league can load.
  if (invite && detail.error instanceof ApiError && detail.error.status === 404) {
    return (
      <Card title="비공개 리그 초대">
        <div className="flex flex-col items-center gap-3 py-6 text-center text-sm text-slate-600 dark:text-slate-300">
          <p>초대받은 비공개 리그입니다. 초대 코드를 확인하고 참가하세요.</p>
          <JoinByCodeForm
            initialCode={invite}
            onJoined={(joinedId) => {
              navigate(`/leagues/${joinedId}`, { replace: true });
              if (joinedId === leagueId) {
                reloadDetail();
                reloadEquity();
              }
            }}
          />
        </div>
      </Card>
    );
  }
  if (detail.error || !detail.data) return <ErrorState error={detail.error} onRetry={() => detail.reload()} />;

  const { league, rankings } = detail.data;
  const myId = league.my_participant_id;
  const myRow = rankings.find((r) => r.participant_id === myId);

  const forceCollect = async () => {
    setAdminMsg(null);
    try {
      const res = await api.adminCollect();
      setAdminMsg(`시세 ${res.count}건을 수집했습니다.`);
      reloadDetail({ silent: true });
    } catch (err) {
      setAdminMsg(errorMessage(err));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Link to="/leagues" className="text-xs text-slate-500 dark:text-slate-400 hover:underline">
            ← 리그 목록
          </Link>
          <h1 className="text-2xl font-bold">{league.name}</h1>
          <LeagueMetaBadges league={league} />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {formatDateTime(league.start_at)} ~ {formatDateTime(league.end_at)} (KST) · AI 판단 주기 {league.decision_interval_min}분 · 하루 주문{' '}
            {league.max_orders_per_day}회
            {unified && ` · 국내·미국 원화 통합 계좌 (미국 종목 환전 비용 ${(league.fx_spread * 100).toFixed(1)}%)`}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="text-lg font-semibold">
            <LeagueCountdown league={league} />
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {unified && league.status !== 'finished' && <FxBadge fx={fx} />}
            <StreamIndicator state={streamState} />
          </div>
          <div className="flex flex-wrap gap-2">
            {league.joined && league.status === 'active' && (
              <Link to={`/leagues/${league.id}/trade`} className={btn.primary}>
                매매하러 가기
              </Link>
            )}
            <JoinLeague
              league={league}
              initialCode={params.get('invite') ?? ''}
              onJoined={() => {
                reloadDetail({ silent: true });
                reloadEquity({ silent: true });
              }}
            />
            <LeaveLeague
              league={league}
              onLeft={(forfeited) => {
                // A private league is hidden from members who left it, so go back to the list instead.
                if (forfeited && !league.is_public) {
                  navigate('/leagues', { replace: true });
                  return;
                }
                reloadDetail({ silent: true });
                reloadEquity({ silent: true });
              }}
            />
            {user?.role === 'admin' && (
              <button type="button" className={btn.secondary} onClick={forceCollect}>
                시세 강제 수집
              </button>
            )}
          </div>
        </div>
      </div>

      {adminMsg && <Alert tone="info">{adminMsg}</Alert>}
      {!league.is_public && (league.joined || user?.role === 'admin') && <InviteCodePanel leagueId={league.id} />}
      {league.left && (
        <Alert tone="warning">이 리그에서 나갔습니다. 순위에서 제외되었으며 다시 참가할 수 없습니다.</Alert>
      )}
      {league.joined && league.status === 'recruiting' && (
        <Alert tone="info">참가 완료! 리그는 {formatDateTime(league.start_at)}에 시작합니다.</Alert>
      )}

      <AveragesStrip detail={detail.data} />

      {myRow && (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4 sm:grid-cols-4">
          <Stat label="내 순위">{myRow.rank !== null ? `${myRow.rank}위 / ${rankings.length}명` : '미집계'}</Stat>
          <Stat label="평가금액">{formatMoney(league.currency, myRow.equity)}</Stat>
          <Stat label="수익률">
            <RateText value={myRow.return_rate} />
          </Stat>
          <Stat label="시작 자금">{formatMoney(league.currency, league.start_cash)}</Stat>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="수익률 추이 (%)" className="lg:col-span-2">
          {equity.loading && !equity.data ? (
            <Loading />
          ) : equity.error ? (
            <ErrorState error={equity.error} onRetry={() => equity.reload()} />
          ) : (
            <Suspense fallback={<Loading label="차트 불러오는 중…" />}>
              <EquityChart series={equity.data ?? []} myParticipantId={myId} />
            </Suspense>
          )}
        </Card>

        <Card title="실시간 AI 활동">
          {activity.length === 0 ? (
            <EmptyState>
              새 AI 판단이 들어오면 여기에 표시됩니다.
              <span className="mt-1 block text-xs">AI는 장중 {league.decision_interval_min}분마다 판단합니다.</span>
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {activity.map((a, i) => (
                <li key={`${a.at}-${i}`} className="text-sm">
                  <div className="flex items-center gap-2">
                    <Link to={`/agents/${a.agent_id}`} className="font-medium hover:underline">
                      {a.agent_name}
                    </Link>
                    <DecisionStatusChip status={a.status} />
                    <span className="ml-auto text-xs text-slate-400">{formatTime(a.at)}</span>
                  </div>
                  {a.summary && <p className="mt-0.5 line-clamp-2 text-xs text-slate-600 dark:text-slate-300">{a.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={`랭킹 (${rankings.length}명)`} actions={<span className="text-xs text-slate-400">체결 1건 이상부터 순위 집계 · 동률은 MDD, 거래 수 순</span>}>
        <RankingsTable rows={rankings} currency={league.currency} myParticipantId={myId} />
      </Card>
    </div>
  );
}
