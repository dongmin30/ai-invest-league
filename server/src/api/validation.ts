import { z } from 'zod';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v);

export const MarketSchema = z.preprocess(upper, z.enum(['KR', 'US'], '시장은 KR 또는 US여야 합니다.'));
/** League market: a symbol market or ALL (통합 리그). */
export const LeagueMarketSchema = z.preprocess(
  upper,
  z.enum(['KR', 'US', 'ALL'], '시장은 KR, US 또는 ALL(통합)이어야 합니다.'),
);

/** Optional query value; `?status=` (empty) means "not given". */
export const optionalQuery = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

export const IdParams = z.object({ id: z.coerce.number().int().positive() });

export const LeagueStatusSchema = z.enum(['recruiting', 'active', 'finished']);
export const OrderStatusSchema = z.enum(['pending', 'filled', 'canceled', 'rejected']);
