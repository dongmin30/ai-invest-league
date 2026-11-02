import type { FxQuote } from '@shared/api-types';
import { useNow } from '../hooks/useNow';
import { formatFxRate, formatFullDateTime, formatHourMinute } from '../lib/format';
import { FX_STALE_MS } from '../lib/leagueRules';
import { cx, PctText } from './ui';

/**
 * USD/KRW pill for 통합 leagues: "USD/KRW 1,335.48 +0.12% · 10:05". Amber when the rate is older
 * than 30 minutes (US fills wait for a fresh rate; valuation keeps using the last one).
 */
export function FxBadge({ fx, className }: { fx: FxQuote | null; className?: string }) {
  const now = useNow(60_000);
  const base = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs tabular-nums';

  if (!fx) {
    return (
      <span className={cx(base, 'border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400', className)}>
        <span className="font-semibold tracking-wide">USD/KRW</span>
        환율 수신 대기 중
      </span>
    );
  }

  const stale = fx.stale || now - fx.ts > FX_STALE_MS;
  const title = stale
    ? `${formatFullDateTime(fx.ts)} 기준 환율입니다. 30분 넘게 갱신되지 않아 미국 종목 체결은 환율이 갱신될 때까지 대기합니다. 평가는 이 환율로 계속됩니다.`
    : `${formatFullDateTime(fx.ts)} 기준 USD/KRW 중간 환율 (${fx.source === 'sim' ? '가상 환율' : 'Yahoo Finance'}). 미국 종목은 체결 시 환전 비용이 더해집니다.`;

  return (
    <span
      className={cx(
        base,
        stale
          ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/70 dark:bg-amber-950/40 dark:text-amber-300'
          : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
        className,
      )}
      title={title}
      aria-label={`USD/KRW 환율 ${formatFxRate(fx.rate)}원${stale ? ', 갱신 지연' : ''}, ${formatHourMinute(fx.ts)} 기준`}
    >
      <span className={cx('font-semibold tracking-wide', stale ? '' : 'text-slate-500 dark:text-slate-400')}>USD/KRW</span>
      <span className={cx('font-semibold', stale ? '' : 'text-slate-900 dark:text-slate-100')}>{formatFxRate(fx.rate)}</span>
      {!stale && <PctText value={fx.change_pct} />}
      <span className={stale ? '' : 'text-slate-400 dark:text-slate-500'}>· {formatHourMinute(fx.ts)}</span>
      {stale && <span className="rounded bg-amber-200/70 px-1 text-[10px] font-semibold dark:bg-amber-800/60">지연</span>}
    </span>
  );
}
