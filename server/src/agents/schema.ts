import { z } from 'zod';

export const MAX_DECISION_ORDERS = 5;
export const MAX_MARKET_VIEW = 300;
export const MAX_REASON = 200;

const DecisionOrderSchema = z.strictObject({
  symbol: z.string().trim().min(1),
  side: z.enum(['BUY', 'SELL']),
  quantity: z.number().int().min(1),
  reason: z.string().max(MAX_REASON),
});

/** What an agent must answer each decision cycle. Unknown keys are rejected at every level. */
export const DecisionSchema = z.strictObject({
  market_view: z.string().max(MAX_MARKET_VIEW),
  orders: z.array(DecisionOrderSchema).max(MAX_DECISION_ORDERS),
});

export type Decision = z.infer<typeof DecisionSchema>;

/** JSON Schema twin of DecisionSchema for structured-output APIs. */
export const decisionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['market_view', 'orders'],
  properties: {
    market_view: { type: 'string', maxLength: MAX_MARKET_VIEW, description: '시장 판단 요약' },
    orders: {
      type: 'array',
      maxItems: MAX_DECISION_ORDERS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol', 'side', 'quantity', 'reason'],
        properties: {
          symbol: { type: 'string', description: '후보 목록의 종목 코드' },
          side: { type: 'string', enum: ['BUY', 'SELL'] },
          quantity: { type: 'integer', minimum: 1 },
          reason: { type: 'string', maxLength: MAX_REASON },
        },
      },
    },
  },
} as const;
