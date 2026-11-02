import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Currency, FxQuote, Holding, LeagueSummary, Market, MarketStatus, Portfolio, StreamEvent } from '@shared/api-types';
import { api, ApiError } from '../api/client';
import { FxBadge } from '../components/FxBadge';
import { JoinLeague } from '../components/JoinLeague';
import { LeagueCountdown, LeagueMetaBadges } from '../components/league';
import { OrderForm } from '../components/OrderForm';
import { HoldingsTable, OrderHistory, PendingOrders } from '../components/PortfolioPanels';
import { StreamIndicator } from '../components/StreamIndicator';
import { SymbolTable } from '../components/SymbolTable';
import { Alert, Card, cx, ErrorState, Loading, RateText, Stat } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useFx } from '../hooks/useFx';
import { useLeagueStream } from '../hooks/useLeagueStream';
import { currencyOf, formatDateTime, formatMoney, MARKET_LABEL } from '../lib/format';
import { usePriceInfo } from '../lib/PriceInfoContext';

const STATUS_REFRESH_MS = 60_000;
const QUOTE_RELOAD_DEBOUNCE_MS = 800;

function MarketBanner({ status, compact }: { status: MarketStatus | undefined; compact?: boolean }) {
  if (!status) return null;
  return (
    <div
      className={cx(
        'flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-xl border text-sm',
        compact ? 'px-3 py-2.5' : 'px-4 py-3',
        status.open ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300' : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200',
      )}
    >
      <div className="flex items-center gap-2 font-semibold">
        <span className={cx('h-2.5 w-2.5 rounded-full', status.open ? 'bg-emerald-500' : 'bg-slate-400')} />
        {MARKET_LABEL[status.market]} 시장 {status.open ? '장중' : '장 마감'}
        <span className="font-normal">
          {status.open
            ? status.next_close && `· ${formatDateTime(status.next_close)} 마감`
            : status.next_open && `· 다음 개장 ${formatDateTime(status.next_open)}`}
        </span>
      </div>
      <span className="text-xs opacity-80">{status.note}</span>
    </div>
  );
}

/**
 * Revalues holdings against live quotes (and, for US holdings of a 통합 league, the live USD/KRW mid)
 * so P&L moves with the stream. Value is in the league currency: native price × qty × fx_rate.
 * The cost basis comes from the server's numbers (value − pnl = qty × avg_price × avg_fx), so the
 * P&L keeps the FX effect without the client knowing avg_fx.
 */
function revalue(portfolio: Portfolio, prices: Map<string, number | null>, fx: FxQuote | null, startCash: number): Portfolio {
  let holdingsValue = 0;
  const holdings: Holding[] = portfolio.holdings.map((h) => {
    const price = prices.get(h.symbol) ?? h.price;
    const fxRate = h.currency !== portfolio.currency && fx ? fx.rate : h.fx_rate;
    const value = price * h.quantity * fxRate;
    const cost = h.value - h.pnl;
    holdingsValue += value;
    return { ...h, price, fx_rate: fxRate, value, pnl: value - cost, pnl_rate: cost > 0 ? value / cost - 1 : 0 };
  });
  const equity = portfolio.cash + holdingsValue;
  return { ...portfolio, holdings, equity, return_rate: startCash > 0 ? equity / startCash - 1 : portfolio.return_rate };
}

function TradeDesk({ league, participantId }: { league: LeagueSummary; participantId: number }) {
  const { reportQuotes } = usePriceInfo();
  const market = league.market;
  const unified = market === 'ALL';
  const symbols = useApi(() => api.symbols(market), [market]); // ALL: both pools
  // /market/:market/status is per symbol market (ALL is a 400), so a 통합 league asks for both.
  const statusMarkets = useMemo<Market[]>(() => (market === 'ALL' ? ['KR', 'US'] : [market]), [market]);
  const status = useApi(() => Promise.all(statusMarkets.map((m) => api.marketStatus(m))), [statusMarkets]);
  const portfolio = useApi(() => api.portfolio(participantId), [participantId]);
  const { fx, push: pushFx } = useFx(unified);
  const orders = useApi(() => api.orders(participantId), [participantId]);
  const [selected, setSelected] = useState<string | null>(null);
  const reloadTimer = useRef<number | undefined>(undefined);

  const { reload: reloadStatus } = status;
  const { reload: reloadPortfolio } = portfolio;
  const { reload: reloadOrders } = orders;
  const { setData: setSymbols } = symbols;

  useEffect(() => {
    const id = window.setInterval(() => reloadStatus({ silent: true }), STATUS_REFRESH_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(reloadTimer.current);
    };
  }, [reloadStatus]);

  useEffect(() => {
    if (symbols.data) reportQuotes(symbols.data.map((s) => ({ ts: s.ts })));
  }, [symbols.data, reportQuotes]);

  // Portfolio reloads carry the server's current rate too.
  useEffect(() => pushFx(portfolio.data?.fx), [portfolio.data, pushFx]);

  const refreshAccount = useCallback(() => {
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      reloadPortfolio({ silent: true });
      reloadOrders({ silent: true });
    }, QUOTE_RELOAD_DEBOUNCE_MS);
  }, [reloadPortfolio, reloadOrders]);

  const onEvent = useCallback(
    (event: StreamEvent) => {
      if (event.type === 'quotes') {
        // A 통합 league stream carries both markets' quotes.
        const mine = market === 'ALL' ? event.quotes : event.quotes.filter((q) => q.market === market);
        if (mine.length === 0) return;
        reportQuotes(mine);
        const byCode = new Map(mine.map((q) => [q.symbol, q]));
        setSymbols((rows) =>
          rows?.map((r) => {
            const q = byCode.get(r.symbol);
            return q ? { ...r, price: q.price, change_pct: q.change_pct, ts: q.ts, stale: false } : r;
          }),
        );
        // Pending orders may have filled on this tick.
        if ((orders.data ?? []).some((o) => o.status === 'pending')) refreshAccount();
      } else if (event.type === 'order' && event.participant_id === participantId) {
        refreshAccount();
      } else if (event.type === 'fx') {
        pushFx(event.fx);
        // US orders waiting on a fresh rate may fill now.
        if ((orders.data ?? []).some((o) => o.status === 'pending')) refreshAccount();
      }
    },
    [market, participantId, orders.data, reportQuotes, setSymbols, refreshAccount, pushFx],
  );
  const streamState = useLeagueStream(league.id, onEvent);

  const prices = useMemo(() => new Map((symbols.data ?? []).map((s) => [s.symbol, s.price])), [symbols.data]);
  const names = useMemo(() => new Map((symbols.data ?? []).map((s) => [s.symbol, s.name])), [symbols.data]);
  const currencies = useMemo(
    () => new Map<string, Currency>((symbols.data ?? []).map((s) => [s.symbol, currencyOf(s.market)])),
    [symbols.data],
  );
  const statuses = useMemo(
    () => Object.fromEntries((status.data ?? []).map((s) => [s.market, s])) as Partial<Record<Market, MarketStatus>>,
    [status.data],
  );
  // A finished league's portfolio is the frozen final result; only live leagues follow the stream.
  const frozen = league.status === 'finished';
  const live = useMemo(
    () => (portfolio.data && !frozen ? revalue(portfolio.data, prices, fx, league.start_cash) : portfolio.data),
    [portfolio.data, prices, fx, league.start_cash, frozen],
  );
  const pending = useMemo(() => (orders.data ?? []).filter((o) => o.status === 'pending'), [orders.data]);
  const history = useMemo(() => (orders.data ?? []).filter((o) => o.status !== 'pending').slice(0, 30), [orders.data]);
  const held = useMemo(() => new Set(live?.holdings.map((h) => h.symbol)), [live]);
  const selectedRow = symbols.data?.find((s) => s.symbol === selected) ?? null;

  const select = (symbol: string) => {
    setSelected(symbol);
    if (window.matchMedia('(max-width: 1023px)').matches) {
      document.getElementById('order-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  if (portfolio.error) return <ErrorState error={portfolio.error} onRetry={() => portfolio.reload()} />;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        {unified ? (
          <div className="grid gap-2 md:grid-cols-2">
            {statusMarkets.map((m) => (
              <MarketBanner key={m} status={statuses[m]} compact />
            ))}
          </div>
        ) : (
          <MarketBanner status={statuses[market as Market]} />
        )}
        <div className={cx('flex flex-wrap items-center gap-2', unified ? 'justify-between' : 'justify-end')}>
          {unified && <FxBadge fx={fx} />}
          <StreamIndicator state={streamState} />
        </div>
      </div>

      {live ? (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-sm sm:grid-cols-4">
          <Stat label="총 평가금액">{formatMoney(live.currency, live.equity)}</Stat>
          <Stat label="수익률">
            <RateText value={live.return_rate} />
          </Stat>
          <Stat label="주문 가능 현금" hint={`보유 현금 ${formatMoney(live.currency, live.cash)}`}>
            {formatMoney(live.currency, live.available_cash)}
          </Stat>
          <Stat label="오늘 주문">
            {live.orders_today} / {live.max_orders_per_day}회
          </Stat>
        </div>
      ) : (
        <Loading />
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title={`${unified ? '국내·미국' : MARKET_LABEL[market]} 종목 (${symbols.data?.length ?? 0})`} className="lg:col-span-2">
          {symbols.loading && !symbols.data ? (
            <Loading />
          ) : symbols.error ? (
            <ErrorState error={symbols.error} onRetry={() => symbols.reload()} />
          ) : (
            <SymbolTable rows={symbols.data ?? []} selected={selected} onSelect={select} holdings={held} fx={unified ? fx : null} />
          )}
        </Card>

        <div id="order-panel" className="min-w-0 scroll-mt-20 lg:sticky lg:top-20 lg:self-start">
          <Card title="주문">
            {live ? (
              <OrderForm
                league={league}
                portfolio={live}
                symbol={selectedRow}
                pendingOrders={pending}
                statuses={statuses}
                fx={unified ? fx : null}
                onPlaced={() => {
                  reloadPortfolio({ silent: true });
                  reloadOrders({ silent: true });
                }}
              />
            ) : (
              <Loading />
            )}
          </Card>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="보유 종목" className="lg:col-span-2">
          {live ? <HoldingsTable holdings={live.holdings} currency={live.currency} onSelect={select} /> : <Loading />}
        </Card>
        <Card title={`대기 주문 (${pending.length})`}>
          {orders.error ? (
            <ErrorState error={orders.error} onRetry={() => orders.reload()} />
          ) : (
            <PendingOrders
              orders={pending}
              currency={league.currency}
              names={names}
              currencies={currencies}
              onCanceled={() => {
                reloadPortfolio({ silent: true });
                reloadOrders({ silent: true });
              }}
            />
          )}
        </Card>
      </div>

      <Card title="최근 주문 내역">
        <OrderHistory orders={history} currency={league.currency} names={names} currencies={currencies} />
      </Card>
    </div>
  );
}

export default function TradePage() {
  const leagueId = Number(useParams().id);
  const detail = useApi(() => api.league(leagueId), [leagueId]);

  if (!Number.isFinite(leagueId)) return <ErrorState error={new ApiError(404, 'not_found', '잘못된 리그 주소입니다.')} />;
  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error || !detail.data) return <ErrorState error={detail.error} onRetry={() => detail.reload()} />;

  const { league } = detail.data;
  const participantId = league.my_participant_id;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <Link to={`/leagues/${league.id}`} className="text-xs text-slate-500 dark:text-slate-400 hover:underline">
            ← 리그 랭킹
          </Link>
          <h1 className="text-2xl font-bold">{league.name} · 매매</h1>
          <LeagueMetaBadges league={league} />
        </div>
        <div className="text-lg font-semibold">
          <LeagueCountdown league={league} />
        </div>
      </div>

      {participantId === null ? (
        <Card>
          <div className="flex flex-col items-center gap-3 py-6 text-center text-sm text-slate-600 dark:text-slate-300">
            <p>이 리그에 참가해야 매매할 수 있습니다.</p>
            <JoinLeague league={league} onJoined={() => detail.reload()} />
          </div>
        </Card>
      ) : (
        <>
          {league.status === 'recruiting' && <Alert tone="info">리그가 {formatDateTime(league.start_at)}에 시작됩니다. 시작 전에는 주문할 수 없습니다.</Alert>}
          {league.status === 'finished' && <Alert tone="info">종료된 리그입니다. 기록만 확인할 수 있습니다.</Alert>}
          <TradeDesk league={league} participantId={participantId} />
        </>
      )}
    </div>
  );
}
