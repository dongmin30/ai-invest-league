import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentInfo, LeagueMarket, LeagueSummary, Market } from '@shared/api-types';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../hooks/useApi';
import { currencyOf, formatMoney, MARKET_LABEL, PROVIDER_LABEL } from '../lib/format';
import { DURATION_MAX, DURATION_MIN, MARKET_RULES, START_CASH_RANGE } from '../lib/leagueRules';
import { Alert, btn, cx, ErrorState, inputClass, Loading, Modal } from './ui';

const FORM_ID = 'create-league-form';

const MARKET_OPTIONS: { value: LeagueMarket; label: string; detail: string }[] = [
  { value: 'KR', label: '국내', detail: 'KOSPI · KOSDAQ' },
  { value: 'US', label: '미국', detail: 'NASDAQ · NYSE' },
  { value: 'ALL', label: '통합', detail: '국내+미국 · 원화' },
];

/** Markets an agent must trade to join: both for a 통합 league. */
function requiredMarkets(market: LeagueMarket): Market[] {
  return market === 'ALL' ? ['KR', 'US'] : [market];
}

function agentUnavailableReason(agent: AgentInfo, market: LeagueMarket, isAdmin: boolean): string | null {
  if (!agent.enabled) return agent.disabled_reason ?? '비활성화됨';
  const missing = requiredMarkets(market).filter((m) => !agent.markets.includes(m));
  if (missing.length > 0) {
    return market === 'ALL'
      ? `통합 리그는 국내·미국을 모두 거래하는 에이전트만 참가 (${missing.map((m) => MARKET_LABEL[m]).join('·')} 미지원)`
      : `${MARKET_LABEL[market]} 시장 미지원`;
  }
  // LLM decisions spend API credit, so the server lets only admins invite them.
  if (agent.provider !== 'rule' && !isAdmin) return 'LLM 에이전트는 관리자만 초대할 수 있습니다';
  return null;
}

export default function CreateLeagueModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (league: LeagueSummary) => void;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const agents = useApi(() => api.agents(), []);
  const [name, setName] = useState('');
  const [market, setMarket] = useState<LeagueMarket>('KR');
  const [durationText, setDurationText] = useState('5');
  const [startCash, setStartCash] = useState(String(MARKET_RULES.KR.start_cash));
  const [cashEdited, setCashEdited] = useState(false);
  const [selected, setSelected] = useState<number[] | null>(null);
  const [isPublic, setIsPublic] = useState(true);
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // The submit button sits in the pinned footer, so bring a new error into view inside the scrolling body.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [error]);

  const available = (agents.data ?? []).filter((a) => agentUnavailableReason(a, market, isAdmin) === null);
  // Until the user touches the picker, every available agent is selected.
  const selectedIds = (selected ?? available.map((a) => a.id)).filter((id) => available.some((a) => a.id === id));

  const changeMarket = (next: LeagueMarket) => {
    setMarket(next);
    if (!cashEdited) setStartCash(String(MARKET_RULES[next].start_cash));
  };

  const toggleAgent = (id: number) => {
    setSelected(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  const duration = Number(durationText);
  const cashValue = Number(startCash);
  const currency = currencyOf(market);
  const cashRange = START_CASH_RANGE[market];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('리그 이름을 입력해 주세요.');
    if (!Number.isInteger(duration) || duration < DURATION_MIN || duration > DURATION_MAX) {
      return setError(`기간은 ${DURATION_MIN}~${DURATION_MAX} 거래일로 입력해 주세요.`);
    }
    if (!Number.isFinite(cashValue) || cashValue < cashRange.min || cashValue > cashRange.max) {
      return setError(`시작 자금은 ${cashRange.label} 사이로 입력해 주세요.`);
    }
    setBusy(true);
    setError(null);
    try {
      const league = await api.createLeague({
        name: trimmed,
        market,
        duration_days: duration,
        start_cash: cashValue,
        agent_ids: selectedIds,
        is_public: isPublic,
        start_now: startNow,
      });
      onCreated(league);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="커스텀 리그 만들기"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn.secondary} onClick={onClose}>
            취소
          </button>
          <button type="submit" form={FORM_ID} className={btn.primary} disabled={busy}>
            {busy ? '만드는 중…' : '리그 만들기'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} className="space-y-5" onSubmit={submit}>

        <label className="block space-y-1">
          <span className="text-sm font-medium">리그 이름</span>
          <input className={inputClass} maxLength={40} required value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 우리 반 AI 대결" />
        </label>

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">시장</legend>
          <div className="grid grid-cols-3 gap-2">
            {MARKET_OPTIONS.map((o) => {
              const active = market === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => changeMarket(o.value)}
                  className={cx(
                    'flex flex-col items-center rounded-lg border px-2 py-2 text-sm font-semibold leading-tight',
                    active
                      ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                      : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50',
                  )}
                  aria-pressed={active}
                >
                  <span className="flex items-center gap-1">
                    {o.value === 'ALL' && (
                      <span className={cx('h-1.5 w-1.5 rounded-full', active ? 'bg-violet-300 dark:bg-violet-600' : 'bg-violet-500 dark:bg-violet-400')} aria-hidden="true" />
                    )}
                    {o.label}
                  </span>
                  <span className={cx('mt-0.5 whitespace-nowrap text-[11px] font-normal', active ? 'opacity-80' : 'text-slate-500 dark:text-slate-400')}>
                    {o.detail}
                  </span>
                </button>
              );
            })}
          </div>
          {market === 'ALL' && (
            <p className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs leading-relaxed text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300">
              원화 계좌 하나로 국내·미국 종목을 모두 거래합니다. 미국 종목은 체결 시점의 USD/KRW 환율로 환전되며 환전 비용 0.1%가 붙습니다.
              하루는 오전 8시에 시작해 국내 장과 이어지는 미국 장을 포함합니다.
            </p>
          )}
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-sm font-medium">기간 ({market === 'ALL' ? '통합 거래일' : '거래일'})</span>
            <input
              className={inputClass}
              type="number"
              min={DURATION_MIN}
              max={DURATION_MAX}
              step={1}
              required
              value={durationText}
              onChange={(e) => setDurationText(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">시작 자금 ({currency === 'KRW' ? '원' : '$'})</span>
            <input
              className={inputClass}
              type="number"
              inputMode="numeric"
              // No numeric step/min: the browser would then only accept min + n·step (min 1, step 10,000
              // rejected 10,000,000 and suggested 10,000,001). The range is checked on submit instead.
              step="any"
              required
              value={startCash}
              onChange={(e) => {
                setStartCash(e.target.value);
                setCashEdited(true);
              }}
            />
          </label>
        </div>
        <p className="-mt-3 text-xs text-slate-500 dark:text-slate-400">
          {Number.isFinite(cashValue) && cashValue > 0 ? formatMoney(currency, cashValue) : '-'} · 기본값 {formatMoney(currency, MARKET_RULES[market].start_cash)} · {cashRange.label}
        </p>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">함께 겨룰 AI 에이전트</legend>
          {agents.loading ? (
            <Loading label="에이전트 목록 불러오는 중…" />
          ) : agents.error ? (
            <ErrorState error={agents.error} onRetry={() => agents.reload()} />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-700/60 rounded-lg border border-slate-200 dark:border-slate-700">
              {(agents.data ?? []).map((agent) => {
                const reason = agentUnavailableReason(agent, market, isAdmin);
                const checked = selectedIds.includes(agent.id);
                return (
                  <li key={agent.id}>
                    <label className={cx('flex items-start gap-3 px-3 py-2', reason ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50')}>
                      <input
                        type="checkbox"
                        className="mt-1"
                        disabled={reason !== null}
                        checked={checked}
                        onChange={() => toggleAgent(agent.id)}
                      />
                      <span className="min-w-0 text-sm">
                        <span className="font-medium">{agent.name}</span>
                        <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
                          {PROVIDER_LABEL[agent.provider]} · {agent.model}
                        </span>
                        {reason && <span className="block text-xs text-rose-600 dark:text-rose-400">사용 불가: {reason}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">공개 설정</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="visibility" checked={isPublic} onChange={() => setIsPublic(true)} />
              공개 (누구나 참가)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="visibility" checked={!isPublic} onChange={() => setIsPublic(false)} />
              초대 코드 전용
            </label>
          </div>
        </fieldset>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
          <span>
            바로 시작
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              해제하면 다음 장 시작 시각{market === 'ALL' ? '(국내·미국 중 먼저 열리는 장)' : ''}에 시작합니다. 커스텀 리그는 진행 중에도 참가할 수 있습니다.
            </span>
          </span>
        </label>

        {error && (
          <div ref={errorRef}>
            <Alert tone="error">{error}</Alert>
          </div>
        )}
      </form>
    </Modal>
  );
}
