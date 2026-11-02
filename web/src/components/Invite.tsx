import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import { useApi } from '../hooks/useApi';
import { btn, cx } from './ui';

const CODE_LENGTH = 6;

/** Invite code and share link of a private league; renders nothing for viewers who may not see it. */
export function InviteCodePanel({ leagueId }: { leagueId: number }) {
  const invite = useApi(() => api.leagueInvite(leagueId), [leagueId]);
  const [copied, setCopied] = useState(false);
  const code = invite.data?.invite_code;
  if (!code) return null;

  const link = `${window.location.origin}/leagues/${leagueId}?invite=${code}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/40 px-4 py-3 text-sm text-indigo-900 dark:text-indigo-200">
      <span className="font-semibold">비공개 리그 초대 코드</span>
      <code className="rounded bg-white dark:bg-slate-800 px-2 py-0.5 font-mono text-base tracking-widest">{code}</code>
      <span className="min-w-0 flex-1 truncate text-xs text-indigo-700 dark:text-indigo-300" title={link}>
        {link}
      </span>
      <button type="button" className={btn.small} onClick={copy}>
        {copied ? '복사됨' : '링크 복사'}
      </button>
    </div>
  );
}

/** Joins a private league from its invite code alone (the league stays hidden until joined). */
export function JoinByCodeForm({ initialCode = '', onJoined, compact }: {
  initialCode?: string;
  onJoined: (leagueId: number, participantId: number) => void;
  compact?: boolean;
}) {
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.joinLeagueByCode(code.trim().toUpperCase());
      onJoined(res.league_id, res.participant_id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Input and button share one bordered pill so they never wrap apart; the error floats
  // below it on wider screens so showing one does not shift the header layout (on phones
  // the controls stack, so it stays in flow instead of covering the next button).
  return (
    <form onSubmit={submit} className="relative">
      <div
        className={cx(
          'flex items-stretch overflow-hidden rounded-lg border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900',
          'focus-within:border-slate-500 focus-within:ring-2 focus-within:ring-slate-300/70 dark:focus-within:border-sky-400 dark:focus-within:ring-sky-500/40',
          compact ? 'h-8' : 'h-10',
        )}
      >
        <span className="flex items-center pl-3 text-slate-400 dark:text-slate-500" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
            <circle cx="7" cy="10" r="3.25" />
            <path d="M10.25 10H17.5M15 10v2.5M17.5 10v2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <input
          className="w-28 bg-transparent px-2 font-mono text-sm uppercase tracking-[0.2em] text-slate-900 outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
          placeholder="초대 코드"
          minLength={CODE_LENGTH}
          maxLength={CODE_LENGTH}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="초대 코드"
        />
        <button
          type="submit"
          disabled={busy}
          className={cx(
            'whitespace-nowrap border-l border-slate-300 bg-slate-50 font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50',
            'dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
            compact ? 'px-2.5 text-xs' : 'px-3.5 text-sm',
          )}
        >
          {busy ? '참가 중…' : '코드로 참가'}
        </button>
      </div>
      {error && (
        <p className="mt-1 text-xs text-rose-600 dark:text-rose-400 sm:absolute sm:right-0 sm:top-full sm:z-10 sm:max-w-xs sm:text-right">{error}</p>
      )}
    </form>
  );
}
