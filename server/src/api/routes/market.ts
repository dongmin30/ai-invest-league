import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FxQuote, SymbolRow } from '../../../../shared/api-types';
import { sql } from '../../engine/store';
import { now } from '../../lib/time';
import { marketDate, sessionBounds } from '../../market/calendar';
import { getFx } from '../../market/fx';
import { marketStatus } from '../../market/index';
import { getQuote, isStale } from '../../market/quoteCache';
import { getSymbol, symbolsFor } from '../../market/symbols';
import { requireUser } from '../auth';
import { notFound } from '../errors';
import { LeagueMarketSchema, MarketSchema } from '../validation';

const MarketParams = z.object({ market: MarketSchema });
/** `/market/ALL/symbols` lists both pools (통합 leagues). */
const PoolParams = z.object({ market: LeagueMarketSchema });
const SymbolParams = z.object({ symbol: z.string().trim().toUpperCase().min(1).max(20) });

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/market/:market/symbols', async (req): Promise<SymbolRow[]> => {
    requireUser(req);
    const { market } = PoolParams.parse(req.params);
    const at = now();
    return symbolsFor(market).map((s) => {
      const q = getQuote(s.symbol);
      return {
        symbol: s.symbol,
        name: s.name,
        market: s.market,
        exchange: s.exchange,
        kind: s.kind,
        leverage: s.leverage,
        underlying: s.underlying ?? null,
        category: s.category,
        price: q?.price ?? null,
        change_pct: q?.change_pct ?? null,
        ts: q?.ts ?? null,
        stale: q ? isStale(q, at) : false,
      };
    });
  });

  // USD/KRW mid for 통합 leagues; null before the first fetch.
  app.get('/market/fx', async (req): Promise<FxQuote | null> => {
    requireUser(req);
    return getFx();
  });

  app.get('/market/:market/status', async (req) => {
    requireUser(req);
    return marketStatus(MarketParams.parse(req.params).market);
  });

  // Minute points of the latest session that has data: today while trading, otherwise the last session.
  app.get('/market/quote/:symbol/intraday', async (req) => {
    requireUser(req);
    const info = getSymbol(SymbolParams.parse(req.params).symbol);
    if (!info) throw notFound('종목을 찾을 수 없습니다.');
    const latest = sql('SELECT MAX(ts) FROM quotes WHERE symbol = ?').pluck().get(info.symbol) as number | null;
    if (latest === null) return { symbol: info.symbol, points: [] };
    const { open, close } = sessionBounds(info.market, marketDate(info.market, latest));
    const points = sql('SELECT ts, price FROM quotes WHERE symbol = ? AND ts BETWEEN ? AND ? ORDER BY ts').all(
      info.symbol,
      Math.min(open, latest),
      Math.max(close, latest),
    ) as { ts: number; price: number }[];
    return { symbol: info.symbol, points };
  });
}
