import type { StreamState } from '../hooks/useLeagueStream';
import { cx } from './ui';

const LABEL: Record<StreamState, string> = {
  connecting: '실시간 연결 중',
  open: '실시간 연결됨',
  reconnecting: '재연결 중',
};

export function StreamIndicator({ state }: { state: StreamState }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400" aria-live="polite">
      <span
        className={cx(
          'h-2 w-2 rounded-full',
          state === 'open' ? 'bg-emerald-500' : state === 'connecting' ? 'bg-slate-400' : 'animate-pulse bg-amber-500',
        )}
      />
      {LABEL[state]}
    </span>
  );
}
