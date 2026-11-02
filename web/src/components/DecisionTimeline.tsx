import { Link } from 'react-router-dom';
import type { DecisionLog, DecisionOrder } from '@shared/api-types';
import { formatFullDateTime, formatInt } from '../lib/format';
import { Badge, cx, EmptyState } from './ui';

const STATUS: Record<DecisionLog['status'], { label: string; tone: 'emerald' | 'slate' | 'amber' | 'rose' | 'orange' }> = {
  ok: { label: '주문 제출', tone: 'emerald' },
  hold: { label: '관망 (HOLD)', tone: 'slate' },
  invalid: { label: '형식 오류', tone: 'amber' },
  error: { label: '오류', tone: 'rose' },
  timeout: { label: '시간 초과', tone: 'orange' },
};

export function DecisionStatusChip({ status }: { status: DecisionLog['status'] }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

interface OrderOutcome {
  order: DecisionOrder;
  rejectedReason: string | null;
}

/** Pairs proposed orders with rejections by symbol, in order; the rest were accepted. */
function outcomes(log: DecisionLog): OrderOutcome[] {
  const pending = [...log.rejected];
  return log.orders.map((order) => {
    const idx = pending.findIndex((r) => r.symbol === order.symbol);
    if (idx < 0) return { order, rejectedReason: null };
    const [hit] = pending.splice(idx, 1);
    return { order, rejectedReason: hit.reason };
  });
}

function DecisionItem({ log, leagueName }: { log: DecisionLog; leagueName?: string }) {
  const items = outcomes(log);
  return (
    <li className="relative pb-6 pl-6 last:pb-0">
      <span className="absolute left-[5px] top-2 h-full w-px bg-slate-200 dark:bg-slate-700" aria-hidden />
      <span
        className={cx(
          'absolute left-0 top-1.5 h-3 w-3 rounded-full border-2 border-white dark:border-slate-800 ring-1',
          log.status === 'ok' ? 'bg-emerald-500 ring-emerald-200 dark:ring-emerald-900' : log.status === 'hold' ? 'bg-slate-400 ring-slate-200 dark:ring-slate-700' : 'bg-rose-500 ring-rose-200 dark:ring-rose-900',
        )}
        aria-hidden
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <DecisionStatusChip status={log.status} />
        <span className="tabular-nums">{formatFullDateTime(log.ts)}</span>
        <Link to={`/leagues/${log.league_id}`} className="hover:underline">
          {leagueName ?? `리그 #${log.league_id}`}
        </Link>
      </div>

      {log.market_view && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">{log.market_view}</p>}
      {log.error && <p className="mt-2 rounded-md bg-rose-50 dark:bg-rose-950/40 px-2 py-1 text-xs text-rose-700 dark:text-rose-300">{log.error}</p>}

      {items.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {items.map(({ order, rejectedReason }, i) => (
            <li key={`${order.symbol}-${i}`} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/40 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cx('font-semibold', order.side === 'BUY' ? 'text-up' : 'text-down')}>{order.side === 'BUY' ? '매수' : '매도'}</span>
                <span className="font-medium">{order.symbol}</span>
                <span className="tabular-nums text-slate-600 dark:text-slate-300">{formatInt(order.quantity)}주</span>
                {rejectedReason ? <Badge tone="rose">거부</Badge> : <Badge tone="emerald">접수</Badge>}
              </div>
              {order.reason && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{order.reason}</p>}
              {rejectedReason && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">거부 사유: {rejectedReason}</p>}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-x-3 text-xs text-slate-400">
        <span>접수 {log.accepted_order_ids.length}건</span>
        {log.input_tokens !== null && <span>입력 {formatInt(log.input_tokens)} 토큰</span>}
        {log.output_tokens !== null && <span>출력 {formatInt(log.output_tokens)} 토큰</span>}
        <span>응답 {(log.latency_ms / 1000).toFixed(1)}초</span>
      </div>
    </li>
  );
}

export function DecisionTimeline({ logs, leagueNames }: { logs: DecisionLog[]; leagueNames: Map<number, string> }) {
  if (logs.length === 0) return <EmptyState>아직 판단 기록이 없습니다. 장이 열리면 리그 판단 주기에 맞춰 기록됩니다.</EmptyState>;
  return (
    <ol>
      {logs.map((log) => (
        <DecisionItem key={log.id} log={log} leagueName={leagueNames.get(log.league_id)} />
      ))}
    </ol>
  );
}
