import { describe, expect, it } from 'vitest';
import { cleanModelText, parseDecision } from '../../src/agents/providers/parse';
import { DecisionSchema, decisionJsonSchema } from '../../src/agents/schema';
import { AgentError } from '../../src/agents/types';

const valid = {
  market_view: '반도체 강세',
  orders: [{ symbol: '005930', side: 'BUY', quantity: 3, reason: '실적 개선' }],
};

describe('DecisionSchema', () => {
  it('accepts a valid decision and an empty order list', () => {
    expect(DecisionSchema.parse(valid)).toEqual(valid);
    expect(DecisionSchema.parse({ market_view: '', orders: [] }).orders).toEqual([]);
  });

  it('rejects extra fields at the top level and inside orders', () => {
    expect(DecisionSchema.safeParse({ ...valid, confidence: 0.9 }).success).toBe(false);
    expect(
      DecisionSchema.safeParse({ ...valid, orders: [{ ...valid.orders[0], type: 'LIMIT', limit_price: 1 }] }).success,
    ).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(DecisionSchema.safeParse({ orders: [] }).success).toBe(false);
    expect(DecisionSchema.safeParse({ market_view: 'x' }).success).toBe(false);
    const { reason: _reason, ...noReason } = valid.orders[0]!;
    expect(DecisionSchema.safeParse({ ...valid, orders: [noReason] }).success).toBe(false);
  });

  it('enforces quantity, side, length and count limits', () => {
    const order = valid.orders[0]!;
    const withOrder = (o: object) => DecisionSchema.safeParse({ ...valid, orders: [{ ...order, ...o }] }).success;
    expect(withOrder({ quantity: 0 })).toBe(false);
    expect(withOrder({ quantity: 1.5 })).toBe(false);
    expect(withOrder({ quantity: '3' })).toBe(false);
    expect(withOrder({ side: 'SHORT' })).toBe(false);
    expect(withOrder({ reason: 'x'.repeat(201) })).toBe(false);
    expect(DecisionSchema.safeParse({ ...valid, market_view: 'x'.repeat(301) }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...valid, orders: Array(6).fill(order) }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...valid, orders: Array(5).fill(order) }).success).toBe(true);
  });
});

describe('decisionJsonSchema', () => {
  it('closes every object and requires every property', () => {
    const objects: Record<string, unknown>[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object') objects.push(n);
      Object.values(n).forEach(walk);
    };
    walk(decisionJsonSchema);
    expect(objects).toHaveLength(2);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
    }
    expect(decisionJsonSchema.properties.orders.maxItems).toBe(5);
    expect(decisionJsonSchema.properties.orders.items.properties.quantity).toEqual({ type: 'integer', minimum: 1 });
  });
});

describe('parseDecision', () => {
  it('strips <think> blocks and code fences', () => {
    const raw = `<think>먼저 생각해보면...</think>\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
    expect(cleanModelText(raw)).toBe(JSON.stringify(valid));
    expect(parseDecision(raw)).toEqual(valid);
  });

  it('throws an invalid AgentError that keeps the raw text', () => {
    for (const raw of ['not json', JSON.stringify({ ...valid, extra: 1 })]) {
      try {
        parseDecision(raw);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as AgentError).kind).toBe('invalid');
        expect((err as AgentError).raw).toBe(raw);
      }
    }
  });
});
