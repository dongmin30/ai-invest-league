import { useMemo, useState } from 'react';
import type { FxQuote, Market, SymbolRow } from '@shared/api-types';
import { formatKrwEquivalent, formatPrice, formatTime } from '../lib/format';
import { cx, EmptyState, inputClass, PctText } from './ui';

type KindFilter = 'all' | 'stock' | 'etf' | 'leveraged';

const FILTERS: { value: KindFilter; label: string; match: (r: SymbolRow) => boolean }[] = [
  { value: 'all', label: '전체', match: () => true },
  { value: 'stock', label: '주식', match: (r) => r.kind === 'stock' },
  { value: 'etf', label: 'ETF', match: (r) => r.kind === 'etf' },
  { value: 'leveraged', label: '레버리지·인버스', match: (r) => r.leverage !== 1 },
];

type MarketFilter = 'any' | Market;

const MARKET_FILTERS: { value: MarketFilter; label: string }[] = [
  { value: 'any', label: '국내+미국' },
  { value: 'KR', label: '국내' },
  { value: 'US', label: '미국' },
];

const chipClass = (active: boolean) =>
  cx(
    'rounded-full border px-3 py-1 text-xs font-medium',
    active
      ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
      : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50',
  );

const badgeClass = 'shrink-0 rounded px-1 text-[10px] font-semibold';
const leverageBadge = 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300';

/** Small kind/leverage badges: "ETF", "2x", "3x", "인버스", "-2x". */
export function InstrumentBadges({ row }: { row: Pick<SymbolRow, 'kind' | 'leverage'> }) {
  if (row.kind !== 'etf') return null;
  return (
    <>
      <span className={cx(badgeClass, 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300')}>ETF</span>
      {row.leverage > 1 && <span className={cx(badgeClass, leverageBadge)}>{row.leverage}x</span>}
      {row.leverage < 0 && (
        <span className={cx(badgeClass, 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300')}>인버스</span>
      )}
      {row.leverage < -1 && <span className={cx(badgeClass, leverageBadge)}>{row.leverage}x</span>}
    </>
  );
}

/**
 * Symbol list with search and kind chips. When the rows hold both markets (통합 leagues) a
 * 국내/미국 filter joins the chip row, and `fx` adds a KRW equivalent under US prices.
 */
export function SymbolTable({ rows, selected, onSelect, holdings, fx }: {
  rows: SymbolRow[];
  selected: string | null;
  onSelect: (symbol: string) => void;
  holdings: Set<string>;
  fx?: FxQuote | null;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [market, setMarket] = useState<MarketFilter>('any');
  const marketCounts = useMemo(() => {
    const kr = rows.filter((r) => r.market === 'KR').length;
    return new Map<MarketFilter, number>([['any', rows.length], ['KR', kr], ['US', rows.length - kr]]);
  }, [rows]);
  const mixed = (marketCounts.get('KR') ?? 0) > 0 && (marketCounts.get('US') ?? 0) > 0;
  const activeMarket: MarketFilter = mixed ? market : 'any';
  const inMarket = useMemo(() => (activeMarket === 'any' ? rows : rows.filter((r) => r.market === activeMarket)), [rows, activeMarket]);
  const counts = useMemo(() => new Map(FILTERS.map((f) => [f.value, inMarket.filter(f.match).length])), [inMarket]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = FILTERS.find((f) => f.value === kind)!.match;
    return inMarket.filter(
      (r) =>
        match(r) &&
        (!q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)),
    );
  }, [inMarket, query, kind]);

  return (
    <div className="space-y-3">
      <input
        className={inputClass}
        type="search"
        placeholder="종목명, 코드 또는 분류 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="종목 검색"
      />
      <div className="flex flex-wrap items-center gap-1">
        {mixed && (
          <>
            <div className="flex flex-wrap gap-1" role="group" aria-label="시장">
              {MARKET_FILTERS.map((f) => {
                const active = activeMarket === f.value;
                return (
                  <button key={f.value} type="button" onClick={() => setMarket(f.value)} aria-pressed={active} className={chipClass(active)}>
                    {f.label} <span className="tabular-nums opacity-70">{marketCounts.get(f.value) ?? 0}</span>
                  </button>
                );
              })}
            </div>
            <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" aria-hidden="true" />
          </>
        )}
        <div className="flex flex-wrap gap-1" role="group" aria-label="종목 유형">
          {FILTERS.map((f) => {
            const active = kind === f.value;
            return (
              <button key={f.value} type="button" onClick={() => setKind(f.value)} aria-pressed={active} className={chipClass(active)}>
                {f.label} <span className="tabular-nums opacity-70">{counts.get(f.value) ?? 0}</span>
              </button>
            );
          })}
        </div>
      </div>
      {filtered.length === 0 ? (
        <EmptyState>조건에 맞는 종목이 없습니다.</EmptyState>
      ) : (
        <div className="-mx-4 max-h-[28rem] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-800">
              <tr className="border-b border-slate-200 dark:border-slate-700 text-left text-xs text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2 font-medium">종목</th>
                <th className="px-2 py-2 text-right font-medium">현재가</th>
                <th className="px-2 py-2 text-right font-medium">등락률</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">시각</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const active = row.symbol === selected;
                return (
                  <tr
                    key={row.symbol}
                    onClick={() => onSelect(row.symbol)}
                    className={cx('cursor-pointer border-b border-slate-100 dark:border-slate-700/60 last:border-0', active ? 'bg-slate-100 dark:bg-slate-700' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50')}
                    aria-selected={active}
                  >
                    {/* w-full + max-w-0: the name column takes the leftover width and truncates, so long
                        US ETF names never push the price columns off a phone screen. */}
                    <td className="w-full max-w-0 px-4 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium" title={row.name}>{row.name}</span>
                        <InstrumentBadges row={row} />
                        {holdings.has(row.symbol) && <span className="shrink-0 rounded bg-amber-100 dark:bg-amber-900/40 px-1 text-[10px] font-semibold text-amber-800 dark:text-amber-300">보유</span>}
                      </div>
                      <div className="truncate text-xs text-slate-400">
                        {row.symbol} · {row.exchange} · {row.category}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                      <div className="font-medium">{formatPrice(row.market, row.price)}</div>
                      {fx && row.market === 'US' && (
                        <div className="text-[11px] text-slate-400 dark:text-slate-500">{formatKrwEquivalent(row.price, fx.rate)}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right">
                      <PctText value={row.change_pct} />
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-2 text-right text-xs tabular-nums sm:table-cell">
                      <span className={row.stale ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'} title={row.stale ? '5분 이상 갱신되지 않은 시세' : undefined}>
                        {formatTime(row.ts)}
                        {row.stale && ' ⚠'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
