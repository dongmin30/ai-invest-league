import type { AgentProvider, LeagueMarket, LeagueStatus, LeagueSummary, ParticipantKind } from '@shared/api-types';
import { useNow } from '../hooks/useNow';
import { formatDuration, LEAGUE_STATUS_LABEL, LEAGUE_TYPE_LABEL, MARKET_LABEL, PROVIDER_LABEL } from '../lib/format';
import { Badge } from './ui';

export function StatusBadge({ status }: { status: LeagueStatus }) {
  const tone = status === 'active' ? 'emerald' : status === 'recruiting' ? 'amber' : 'slate';
  return <Badge tone={tone}>{LEAGUE_STATUS_LABEL[status]}</Badge>;
}

export function MarketBadge({ market }: { market: LeagueMarket }) {
  const tone = market === 'KR' ? 'rose' : market === 'US' ? 'sky' : 'violet';
  return <Badge tone={tone}>{MARKET_LABEL[market]} {market === 'ALL' ? 'KR+US' : market}</Badge>;
}

export function LeagueMetaBadges({ league }: { league: LeagueSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusBadge status={league.status} />
      <MarketBadge market={league.market} />
      <Badge>{LEAGUE_TYPE_LABEL[league.type]}</Badge>
      {!league.is_public && <Badge tone="violet">초대 전용</Badge>}
      {league.joined && <Badge tone="emerald">참가 중</Badge>}
    </div>
  );
}

export function KindBadge({ kind, provider, model }: {
  kind: ParticipantKind;
  provider?: AgentProvider | null;
  model?: string | null;
}) {
  if (kind === 'human') return <Badge tone="slate">사람</Badge>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone="violet">AI</Badge>
      {model && (
        <span className="text-xs text-slate-500 dark:text-slate-400" title={provider ? PROVIDER_LABEL[provider] : undefined}>
          {model}
        </span>
      )}
    </span>
  );
}

/** Counts down to `target` (epoch ms). */
export function Countdown({ target, prefix }: { target: number; prefix?: string }) {
  const now = useNow(1000);
  const remaining = target - now;
  return (
    <span className="tabular-nums">
      {prefix && <span className="mr-1 text-slate-500 dark:text-slate-400">{prefix}</span>}
      {remaining > 0 ? formatDuration(remaining) : '곧 갱신'}
    </span>
  );
}

/** Countdown label for a league: until start when recruiting, until end when active. */
export function LeagueCountdown({ league }: { league: LeagueSummary }) {
  if (league.status === 'finished') return <span className="text-slate-500 dark:text-slate-400">종료됨</span>;
  return league.status === 'recruiting' ? (
    <Countdown target={league.start_at} prefix="시작까지" />
  ) : (
    <Countdown target={league.end_at} prefix="종료까지" />
  );
}
