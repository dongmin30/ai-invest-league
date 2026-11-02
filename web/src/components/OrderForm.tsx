import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { FxQuote, LeagueSummary, Market, MarketStatus, Order, OrderSide, OrderType, Portfolio, SymbolRow } from '@shared/api-types';
import { api, errorMessage } from '../api/client';
import { useNow } from '../hooks/useNow';
import {
  currencyOf,
  formatDateTime,
  formatFxRate,
  formatInt,
  formatKrwEquivalent,
  formatMoney,
  MARKET_LABEL,
  ORDER_STATUS_LABEL,
} from '../lib/format';
import { appliedFx, convertsFx, FX_STALE_MS, ratesFor } from '../lib/leagueRules';
import { InstrumentBadges } from './SymbolTable';
import { Alert, btn, cx, inputClass, PctText } from './ui';

function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string; activeClass: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid grid-flow-col gap-1 rounded-lg bg-slate-100 dark:bg-slate-700 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cx('rounded-md px-3 py-1.5 text-sm font-semibold', value === o.value ? o.activeClass : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children, muted }: { label: ReactNode; children: ReactNode; muted?: boolean }) {
  return (
    <div className={cx('flex justify-between gap-3', muted && 'text-xs')}>
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className={cx('text-right tabular-nums', muted && 'text-slate-500 dark:text-slate-400')}>{children}</dd>
    </div>
  );
}

/**
 * Order ticket. Fees, taxes and the open/closed state follow the selected symbol's market, so a
 * 통합 league charges each symbol its own rules; US symbols there are priced in USD and settled
 * in KRW at the USD/KRW mid ± fx_spread (환전 비용).
 */
export function OrderForm({ league, portfolio, symbol, pendingOrders, statuses, fx, onPlaced }: {
  league: LeagueSummary;
  portfolio: Portfolio;
  symbol: SymbolRow | null;
  pendingOrders: Order[];
  /** Market status per symbol market (both for 통합 leagues). */
  statuses: Partial<Record<Market, MarketStatus>>;
  /** Live USD/KRW for 통합 leagues, null otherwise or before the first rate. */
  fx: FxQuote | null;
  onPlaced: (order: Order) => void;
}) {
  const now = useNow(60_000);
  const [side, setSide] = useState<OrderSide>('BUY');
  const [type, setType] = useState<OrderType>('MARKET');
  const [qtyText, setQtyText] = useState('');
  const [limitText, setLimitText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const symbolCode = symbol?.symbol ?? null;
  useEffect(() => {
    setQtyText('');
    setLimitText('');
    setResult(null);
  }, [symbolCode]);

  // Cash, fees and totals are in the league currency; prices (incl. the limit) are in the symbol's.
  const currency = league.currency;
  const symbolMarket: Market | null = symbol?.market ?? (league.market === 'ALL' ? null : league.market);
  const nativeCurrency = symbolMarket ? currencyOf(symbolMarket) : currency;
  const rates = ratesFor(league.market, symbol);
  const priceStep = nativeCurrency === 'KRW' ? 1 : 0.01;
  const quantity = Number(qtyText);
  const limitPrice = Number(limitText);
  const refPrice = type === 'LIMIT' ? (limitPrice > 0 ? limitPrice : null) : symbol?.price ?? null;
  const validQty = Number.isInteger(quantity) && quantity > 0;

  // US symbol in a 통합 league: the fill converts at mid × (1 ± spread). The estimate uses the live mid.
  const converts = convertsFx(league, symbolMarket);
  const fxMid = converts ? (fx?.rate ?? null) : 1;
  const fxApplied = converts ? (fxMid !== null ? appliedFx(fxMid, side, league.fx_spread) : null) : 1;
  const fxStale = converts && fx !== null && (fx.stale || now - fx.ts > FX_STALE_MS);

  const nativeAmount = validQty && refPrice !== null ? quantity * refPrice : null;
  const amount = nativeAmount !== null && fxApplied !== null ? nativeAmount * fxApplied : null;
  const fxCost = converts && nativeAmount !== null && fxMid !== null ? nativeAmount * fxMid * league.fx_spread : null;
  const fee = amount !== null ? amount * rates.fee_rate : null;
  const taxExempt = rates.base_tax_rate > 0 && rates.tax_rate === 0;
  const tax = amount !== null && side === 'SELL' ? amount * rates.tax_rate : 0;
  const total = amount !== null && fee !== null ? (side === 'BUY' ? amount + fee : amount - fee - tax) : null;

  const holding = portfolio.holdings.find((h) => h.symbol === symbolCode);
  const pendingSell = pendingOrders
    .filter((o) => o.symbol === symbolCode && o.side === 'SELL')
    .reduce((sum, o) => sum + o.quantity, 0);
  const sellable = Math.max(0, (holding?.quantity ?? 0) - pendingSell);
  // Per share in the league currency, including the BUY spread and the fee (what the server reserves).
  const buyUnitCost = refPrice && fxApplied ? refPrice * fxApplied * (1 + rates.fee_rate) : null;
  const maxBuy = buyUnitCost ? Math.max(0, Math.floor(portfolio.available_cash / buyUnitCost)) : 0;
  const maxQty = side === 'BUY' ? maxBuy : sellable;
  const remainingOrders = Math.max(0, portfolio.max_orders_per_day - portfolio.orders_today);

  const disabledReason =
    league.status !== 'active'
      ? league.status === 'recruiting'
        ? '리그 시작 후 주문할 수 있습니다.'
        : '종료된 리그입니다.'
      : !symbol
        ? '종목 목록에서 종목을 선택하세요.'
        : remainingOrders === 0
          ? '오늘 주문 가능 횟수를 모두 사용했습니다.'
          : converts && !fx
            ? '환율을 받기 전에는 미국 종목을 주문할 수 없습니다.'
            : null;
  const status = symbolMarket ? statuses[symbolMarket] : undefined;
  const marketClosed = status !== undefined && !status.open;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!symbol) return;
    if (!validQty) {
      setResult({ tone: 'error', text: '수량은 1주 이상의 정수로 입력해 주세요.' });
      return;
    }
    if (type === 'LIMIT' && !(limitPrice > 0)) {
      setResult({ tone: 'error', text: '지정가를 입력해 주세요.' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const order = await api.placeOrder(portfolio.participant_id, {
        symbol: symbol.symbol,
        side,
        type,
        quantity,
        ...(type === 'LIMIT' ? { limit_price: limitPrice } : {}),
      });
      setResult({
        tone: 'success',
        text: `${symbol.name} ${formatInt(quantity)}주 ${side === 'BUY' ? '매수' : '매도'} 주문이 접수되었습니다. (${ORDER_STATUS_LABEL[order.status]})`,
      });
      setQtyText('');
      onPlaced(order);
    } catch (err) {
      setResult({ tone: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {symbol ? (
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-base font-semibold">{symbol.name}</span>
              <InstrumentBadges row={symbol} />
            </div>
            <div className="text-xs text-slate-400">
              {symbol.symbol} · {symbol.category}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-semibold tabular-nums">{formatMoney(nativeCurrency, symbol.price)}</div>
            {converts && fxMid !== null && (
              <div className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">{formatKrwEquivalent(symbol.price, fxMid)}</div>
            )}
            <PctText value={symbol.change_pct} className="text-xs" />
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">종목을 선택하세요.</p>
      )}

      <Segmented<OrderSide>
        value={side}
        onChange={setSide}
        options={[
          { value: 'BUY', label: '매수', activeClass: 'bg-up text-white shadow-sm dark:bg-red-600' },
          { value: 'SELL', label: '매도', activeClass: 'bg-down text-white shadow-sm dark:bg-blue-600' },
        ]}
      />
      <Segmented<OrderType>
        value={type}
        onChange={(t) => {
          setType(t);
          if (t === 'LIMIT' && !limitText && symbol?.price) setLimitText(String(symbol.price));
        }}
        options={[
          { value: 'MARKET', label: '시장가', activeClass: 'bg-white text-slate-900 shadow-sm dark:bg-slate-600 dark:text-slate-100' },
          { value: 'LIMIT', label: '지정가', activeClass: 'bg-white text-slate-900 shadow-sm dark:bg-slate-600 dark:text-slate-100' },
        ]}
      />

      {type === 'LIMIT' && (
        <label className="block space-y-1">
          <span className="flex flex-wrap justify-between gap-x-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            <span>지정가 ({nativeCurrency === 'KRW' ? '원' : 'USD $'})</span>
            {converts && limitPrice > 0 && fxApplied !== null && (
              <span className="font-normal tabular-nums text-slate-500 dark:text-slate-400">
                {formatKrwEquivalent(limitPrice, fxApplied)} (적용 환율 {formatFxRate(fxApplied)})
              </span>
            )}
          </span>
          <input
            className={inputClass}
            type="number"
            inputMode="decimal"
            min={priceStep}
            step={priceStep}
            value={limitText}
            onChange={(e) => setLimitText(e.target.value)}
          />
        </label>
      )}

      <label className="block space-y-1">
        <span className="flex justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
          <span>수량 (주)</span>
          <span className="font-normal text-slate-500 dark:text-slate-400">
            {side === 'BUY' ? '최대 매수' : '매도 가능'} {formatInt(maxQty)}주
          </span>
        </span>
        <div className="flex gap-2">
          <input
            className={inputClass}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={qtyText}
            onChange={(e) => setQtyText(e.target.value)}
            placeholder="0"
          />
          <button type="button" className={cx(btn.secondary, 'shrink-0 whitespace-nowrap')} disabled={maxQty === 0} onClick={() => setQtyText(String(maxQty))}>
            최대
          </button>
        </div>
      </label>

      <dl className="space-y-1 rounded-lg bg-slate-50 dark:bg-slate-700/40 p-3 text-sm">
        {converts && (
          <>
            <Row label="주문금액 (USD)">{formatMoney('USD', nativeAmount)}</Row>
            <Row label="적용 환율" muted>
              {fxApplied !== null && fxMid !== null ? (
                <>
                  {formatFxRate(fxApplied)}
                  <span className="ml-1 text-slate-400 dark:text-slate-500">
                    (기준 {formatFxRate(fxMid)} {side === 'BUY' ? '+' : '−'}
                    {(league.fx_spread * 100).toFixed(2)}%)
                  </span>
                </>
              ) : (
                '환율 수신 대기'
              )}
            </Row>
          </>
        )}
        <Row label={converts ? '원화 환산 금액' : '예상 주문금액'}>
          {converts && amount !== null ? '≈ ' : ''}
          {formatMoney(currency, amount)}
        </Row>
        {converts && (
          <Row label={`환전 비용 (${(league.fx_spread * 100).toFixed(2)}%, 포함)`} muted>
            {formatMoney(currency, fxCost)}
          </Row>
        )}
        <Row label={`수수료 (${(rates.fee_rate * 100).toFixed(3)}%)`}>{formatMoney(currency, fee)}</Row>
        {side === 'SELL' && rates.base_tax_rate > 0 && (
          <Row label={taxExempt ? '거래세 (ETF 면제)' : `거래세 (${(rates.tax_rate * 100).toFixed(2)}%)`}>{formatMoney(currency, tax)}</Row>
        )}
        <div className="flex justify-between border-t border-slate-200 dark:border-slate-700 pt-1 font-semibold">
          <dt>{side === 'BUY' ? '총 필요금액' : '예상 수령액'}</dt>
          <dd className="tabular-nums">{formatMoney(currency, total)}</dd>
        </div>
        <p className="pt-1 text-xs text-slate-400">
          {type === 'MARKET' ? '시장가는 다음 시세 갱신 시점의 가격으로 체결됩니다.' : '지정가는 시세가 조건에 도달하면 체결됩니다.'}
          {converts && ' 원화 금액은 체결 시점 환율로 확정됩니다.'}
        </p>
      </dl>

      {symbol && symbol.leverage !== 1 && (
        <Alert tone="warning">
          {symbol.leverage < 0 ? '인버스' : '레버리지'} 상품입니다. {symbol.underlying ?? '기초지수'}의 하루 수익률의{' '}
          {symbol.leverage}배를 추종하므로 오래 보유하면 변동성 때문에 가치가 줄어들 수 있고, 손실도 배로 커집니다.
        </Alert>
      )}
      {marketClosed && league.status === 'active' && symbolMarket && (
        <Alert tone="warning">
          {league.market === 'ALL' ? `${MARKET_LABEL[symbolMarket]} 시장이` : '현재 장이'} 닫혀 있습니다. 주문은 대기 상태로 접수되고
          {status?.next_open ? ` ${formatDateTime(status.next_open)} 개장 후` : ' 장이 열린 뒤'} 첫 시세에 체결됩니다.
        </Alert>
      )}
      {fxStale && league.status === 'active' && (
        <Alert tone="warning">환율이 30분 넘게 갱신되지 않았습니다. 미국 종목 주문은 접수되지만 환율이 갱신될 때까지 체결이 대기됩니다.</Alert>
      )}
      {result && <Alert tone={result.tone}>{result.text}</Alert>}

      <button
        type="submit"
        className={cx(
          'w-full rounded-lg py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50',
          side === 'BUY' ? 'bg-up hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500' : 'bg-down hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500',
        )}
        disabled={busy || disabledReason !== null}
      >
        {busy ? '주문 중…' : side === 'BUY' ? '매수 주문' : '매도 주문'}
      </button>
      <p className="text-center text-xs text-slate-500 dark:text-slate-400">
        {disabledReason ?? `오늘 주문 ${portfolio.orders_today}/${portfolio.max_orders_per_day}회 · 남은 횟수 ${remainingOrders}회`}
      </p>
    </form>
  );
}
