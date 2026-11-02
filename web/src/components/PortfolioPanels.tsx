import { useState } from 'react';
import type { Currency, Holding, Order } from '@shared/api-types';
import { api, errorMessage } from '../api/client';
import { formatDateTime, formatFxRate, formatInt, formatMoney, formatSignedMoney, ORDER_STATUS_LABEL } from '../lib/format';
import { Badge, btn, cx, EmptyState, RateText } from './ui';

/**
 * Prices (평균단가, 현재가) are in each holding's native currency; 평가금액 and 손익 are in the
 * league currency (KRW in 통합 leagues, with the FX effect in the P&L).
 */
export function HoldingsTable({ holdings, currency, onSelect }: {
  holdings: Holding[];
  currency: Currency;
  onSelect: (symbol: string) => void;
}) {
  const converted = holdings.some((h) => h.currency !== currency);
  if (holdings.length === 0) return <EmptyState>보유 종목이 없습니다.</EmptyState>;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[32rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-700 text-left text-xs text-slate-500 dark:text-slate-400">
            <th className="px-4 py-2 font-medium">종목</th>
            <th className="px-2 py-2 text-right font-medium">수량</th>
            <th className="px-2 py-2 text-right font-medium">평균단가</th>
            <th className="px-2 py-2 text-right font-medium">현재가</th>
            <th className="px-2 py-2 text-right font-medium">평가금액{converted ? ' (원화)' : ''}</th>
            <th className="px-4 py-2 text-right font-medium">손익</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.symbol} className="cursor-pointer border-b border-slate-100 dark:border-slate-700/60 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-700/50" onClick={() => onSelect(h.symbol)}>
              <td className="px-4 py-2">
                <div className="font-medium">{h.name}</div>
                <div className="text-xs text-slate-400">{h.symbol}</div>
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{formatInt(h.quantity)}</td>
              <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatMoney(h.currency, h.avg_price)}</td>
              <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                <div>{formatMoney(h.currency, h.price)}</div>
                {h.currency !== currency && (
                  <div className="text-[11px] text-slate-400 dark:text-slate-500" title="평가에 쓰인 USD/KRW 중간 환율">
                    환율 {formatFxRate(h.fx_rate)}
                  </div>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatMoney(currency, h.value)}</td>
              <td className="whitespace-nowrap px-4 py-2 text-right">
                <div className={cx('tabular-nums', h.pnl > 0 ? 'text-up' : h.pnl < 0 ? 'text-down' : 'text-slate-500 dark:text-slate-400')}>
                  {formatSignedMoney(currency, h.pnl)}
                </div>
                <RateText value={h.pnl_rate} className="text-xs" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SideText({ side }: { side: Order['side'] }) {
  return <span className={cx('font-semibold', side === 'BUY' ? 'text-up' : 'text-down')}>{side === 'BUY' ? '매수' : '매도'}</span>;
}

export function PendingOrders({ orders, currency, names, currencies, onCanceled }: {
  orders: Order[];
  currency: Currency;
  names: Map<string, string>;
  /** Native currency per symbol (limit prices are native); falls back to the league currency. */
  currencies?: Map<string, Currency>;
  onCanceled: (order: Order) => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (orders.length === 0) return <EmptyState>대기 중인 주문이 없습니다.</EmptyState>;

  const cancel = async (id: number) => {
    setBusyId(id);
    setError(null);
    try {
      onCanceled(await api.cancelOrder(id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-700/60">
        {orders.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <SideText side={o.side} />
                <span className="truncate font-medium">{names.get(o.symbol) ?? o.symbol}</span>
                <span className="tabular-nums">{formatInt(o.quantity)}주</span>
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {o.type === 'LIMIT' ? `지정가 ${formatMoney(currencies?.get(o.symbol) ?? currency, o.limit_price)}` : '시장가'} ·{' '}
                {formatDateTime(o.created_at)}
              </div>
            </div>
            <button type="button" className={btn.small} disabled={busyId !== null} onClick={() => cancel(o.id)}>
              {busyId === o.id ? '취소 중…' : '취소'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OrderHistory({ orders, currency, names, currencies }: {
  orders: Order[];
  currency: Currency;
  names: Map<string, string>;
  /** Native currency per symbol (fill/limit prices are native); falls back to the league currency. */
  currencies?: Map<string, Currency>;
}) {
  if (orders.length === 0) return <EmptyState>주문 내역이 없습니다.</EmptyState>;
  const tone = { filled: 'emerald', canceled: 'slate', rejected: 'rose', pending: 'amber' } as const;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-700/60">
      {orders.map((o) => {
        // A fill with fx_rate is a US symbol in a 통합 league: USD price, KRW fee/tax.
        const native = o.fx_rate !== null ? 'USD' : (currencies?.get(o.symbol) ?? currency);
        return (
        <li key={o.id} className="py-2 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={tone[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Badge>
            <SideText side={o.side} />
            <span className="font-medium">{names.get(o.symbol) ?? o.symbol}</span>
            <span className="tabular-nums">{formatInt(o.quantity)}주</span>
            <span className="ml-auto text-xs text-slate-400">{formatDateTime(o.filled_at ?? o.created_at)}</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {o.status === 'filled' && o.fill_price !== null ? (
              <>
                체결가 {formatMoney(native, o.fill_price)}
                {o.fx_rate !== null && ` · 환율 ${formatFxRate(o.fx_rate)}`} · 수수료 {formatMoney(currency, o.fee)}
                {o.tax ? ` · 세금 ${formatMoney(currency, o.tax)}` : ''}
              </>
            ) : o.status === 'rejected' && o.reject_reason ? (
              <span className="text-rose-600 dark:text-rose-400">{o.reject_reason}</span>
            ) : o.type === 'LIMIT' ? (
              `지정가 ${formatMoney(native, o.limit_price)}`
            ) : (
              '시장가'
            )}
          </div>
        </li>
        );
      })}
    </ul>
  );
}
