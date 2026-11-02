import { useState, type FormEvent } from 'react';
import type { LeagueSummary } from '@shared/api-types';
import { api, errorMessage } from '../api/client';
import { OFFICIAL_JOIN_GRACE_MS } from '../lib/leagueRules';
import { btn, cx, inputClass } from './ui';

/** Mirrors server engine/leagues.ts isJoinable. */
export function canJoin(league: LeagueSummary, at: number = Date.now()): boolean {
  if (league.joined || league.left) return false;
  if (league.status === 'recruiting') return true;
  if (league.status !== 'active' || at >= league.end_at) return false;
  return league.type === 'custom' || at < league.start_at + OFFICIAL_JOIN_GRACE_MS;
}

/** Join button; private leagues ask for the 6-character invite code first. */
export function JoinLeague({ league, initialCode = '', onJoined, compact }: {
  league: LeagueSummary;
  initialCode?: string;
  onJoined: (participantId: number) => void;
  compact?: boolean;
}) {
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (league.joined) return null;
  if (league.left) return <span className="text-xs text-slate-400">나간 리그</span>;
  if (!canJoin(league)) return <span className="text-xs text-slate-400">참가 마감</span>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.joinLeague(league.id, league.is_public ? undefined : code.trim().toUpperCase());
      onJoined(res.participant_id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-1">
      <div className="flex gap-2">
        {!league.is_public && (
          <input
            className={cx(inputClass, 'w-28 uppercase', compact && 'py-1')}
            placeholder="초대 코드"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="초대 코드"
          />
        )}
        <button type="submit" className={compact ? btn.small : btn.primary} disabled={busy}>
          {busy ? '참가 중…' : '참가하기'}
        </button>
      </div>
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </form>
  );
}
