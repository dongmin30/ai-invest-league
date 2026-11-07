import { useState } from 'react';
import type { LeagueMarket, OfficialSeries } from '@shared/api-types';
import { api, errorMessage } from '../api/client';
import { useApi } from '../hooks/useApi';
import { LEAGUE_TYPE_LABEL, MARKET_LABEL } from '../lib/format';
import { Alert, btn, cx, ErrorState, Loading, Modal } from './ui';

const MARKETS: LeagueMarket[] = ['KR', 'US', 'ALL'];
const dangerBtn =
  'inline-flex items-center justify-center gap-1 rounded-lg bg-rose-600 dark:bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 dark:hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-50';

function Switch({ on, disabled, label, onClick }: { on: boolean; disabled: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        on ? 'bg-emerald-500 dark:bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600',
      )}
    >
      <span className={cx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', on ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}

const seriesName = (s: OfficialSeries) => `${MARKET_LABEL[s.market]} ${LEAGUE_TYPE_LABEL[s.type]} 리그`;

/**
 * Admin-only switches for the 9 auto-run official league series (market × length). Off is the
 * default; turning one off ends its active league now and deletes its recruiting one (confirmed first).
 */
export default function OfficialSeriesPanel({ onChanged }: { onChanged: () => void }) {
  const series = useApi(() => api.adminOfficialSeries(), []);
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<OfficialSeries | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = async (s: OfficialSeries, enabled: boolean) => {
    const key = `${s.market}/${s.type}`;
    setPending(key);
    setError(null);
    try {
      series.setData(await api.adminSetOfficialSeries(s.market, s.type, enabled));
      setConfirming(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  const toggle = (s: OfficialSeries) => {
    if (s.enabled && s.active_count + s.recruiting_count > 0) setConfirming(s);
    else void apply(s, !s.enabled);
  };

  return (
    <section className="rounded-xl border border-amber-300/70 dark:border-amber-700/60 bg-amber-50/60 dark:bg-amber-950/20 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">공식 리그 자동 운영 (관리자)</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">켠 종류만 자동으로 만들어지고 AI가 참가합니다. 끄면 진행 중인 리그는 바로 종료됩니다.</p>
      </div>
      {error && !confirming && (
        <div className="mb-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {series.loading ? (
        <Loading />
      ) : series.error ? (
        <ErrorState error={series.error} onRetry={() => series.reload()} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          {MARKETS.map((market) => (
            <div key={market} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3">
              <div className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">{MARKET_LABEL[market]}</div>
              <ul className="space-y-2">
                {(series.data ?? [])
                  .filter((s) => s.market === market)
                  .map((s) => {
                    const key = `${s.market}/${s.type}`;
                    const counts = [s.active_count > 0 && `진행중 ${s.active_count}`, s.recruiting_count > 0 && `모집중 ${s.recruiting_count}`]
                      .filter(Boolean)
                      .join(' · ');
                    return (
                      <li key={key} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{LEAGUE_TYPE_LABEL[s.type]}</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">{s.enabled ? counts || '다음 장 시작 시 생성' : '꺼짐'}</div>
                        </div>
                        <Switch on={s.enabled} disabled={pending !== null} label={`${seriesName(s)} 자동 운영`} onClick={() => toggle(s)} />
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <Modal
          title="공식 리그 끄기"
          onClose={() => {
            if (pending !== null) return;
            setConfirming(null);
            setError(null);
          }}
          footer={
            <>
              <button
                type="button"
                className={btn.secondary}
                disabled={pending !== null}
                onClick={() => {
                  setConfirming(null);
                  setError(null);
                }}
              >
                취소
              </button>
              <button type="button" className={dangerBtn} disabled={pending !== null} onClick={() => void apply(confirming, false)}>
                {pending !== null ? '처리 중…' : '끄기'}
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
            {error && <Alert tone="error">{error}</Alert>}
            <p>
              <span className="font-semibold">{seriesName(confirming)}</span> 자동 운영을 끕니다.
            </p>
            <Alert tone="warning">
              {confirming.active_count > 0 && (
                <span className="block">
                  진행 중인 리그 {confirming.active_count}개는 지금 종료됩니다. 대기 주문은 취소되고 현재 순위로 마감되며, 기록은 &lsquo;종료&rsquo; 탭에 남습니다.
                </span>
              )}
              {confirming.recruiting_count > 0 && (
                <span className="block">시작 전인 리그 {confirming.recruiting_count}개는 참가 기록과 함께 삭제됩니다.</span>
              )}
            </Alert>
          </div>
        </Modal>
      )}
    </section>
  );
}
