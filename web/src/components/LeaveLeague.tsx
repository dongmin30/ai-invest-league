import { useState } from 'react';
import type { LeagueSummary } from '@shared/api-types';
import { api, errorMessage } from '../api/client';
import { Alert, btn, Modal } from './ui';

// btn.secondary / btn.small with rose text (Tailwind cannot override their text color by class order).
const leaveBtn = {
  normal:
    'inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:cursor-not-allowed disabled:opacity-50',
  small:
    'inline-flex items-center justify-center rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:cursor-not-allowed disabled:opacity-50',
};
const dangerBtn =
  'inline-flex items-center justify-center gap-1 rounded-lg bg-rose-600 dark:bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 dark:hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-50';

/** Mirrors server engine/leagues.ts leaveLeague: joined and not finished (nor past end_at). */
export function canLeave(league: LeagueSummary, at: number = Date.now()): boolean {
  return league.joined && (league.status === 'recruiting' || (league.status === 'active' && at < league.end_at));
}

/** "리그 나가기" button with a confirm dialog that explains what leaving means for this league's status. */
export function LeaveLeague({ league, onLeft, compact }: {
  league: LeagueSummary;
  onLeft: (forfeited: boolean) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canLeave(league)) return null;
  const recruiting = league.status === 'recruiting';

  const close = () => {
    if (busy) return;
    setOpen(false);
    setError(null);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.leaveLeague(league.id);
      setOpen(false);
      onLeft(res.forfeited);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={compact ? leaveBtn.small : leaveBtn.normal} onClick={() => setOpen(true)}>
        리그 나가기
      </button>
      {open && (
        <Modal title="리그 나가기" onClose={close}>
          <div className="space-y-4 text-sm text-slate-700 dark:text-slate-200">
            <p>
              <span className="font-semibold">{league.name}</span>에서 나가시겠습니까?
            </p>
            {recruiting ? (
              <Alert tone="info">아직 시작 전인 리그라 참가 기록이 삭제됩니다. 모집 중에는 언제든 다시 참가할 수 있습니다.</Alert>
            ) : (
              <Alert tone="warning">
                진행 중인 리그에서 나가면 기권 처리됩니다. 대기 중인 주문은 모두 취소되고, 보유 종목은 정리되지 않은 채 순위와
                평균에서 제외됩니다. 이 리그에는 다시 참가할 수 없습니다.
                {!league.is_public && <span className="mt-1 block">비공개 리그는 리그를 만든 사람이 아니면 나간 뒤 더 이상 볼 수 없습니다.</span>}
              </Alert>
            )}
            {error && <Alert tone="error">{error}</Alert>}
            <div className="flex justify-end gap-2 border-t border-slate-100 dark:border-slate-700/60 pt-4">
              <button type="button" className={btn.secondary} onClick={close} disabled={busy}>
                취소
              </button>
              <button type="button" className={dangerBtn} onClick={confirm} disabled={busy}>
                {busy ? '나가는 중…' : recruiting ? '참가 취소' : '기권하고 나가기'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
