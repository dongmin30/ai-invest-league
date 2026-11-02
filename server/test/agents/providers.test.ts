import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeProvider, toClaudeSchema, type ClaudeClient } from '../../src/agents/providers/claude';
import { createOllamaProvider } from '../../src/agents/providers/ollama';
import { decisionJsonSchema } from '../../src/agents/schema';
import { AgentError } from '../../src/agents/types';
import { config } from '../../src/config';
import { candidate, pureInput } from './fixtures';

const decision = {
  market_view: '반도체 반등 기대',
  orders: [{ symbol: '005930', side: 'BUY', quantity: 5, reason: '저평가' }],
};
const input = pureInput({ candidates: [candidate('005930', 70_000)] });

function message(overrides: Partial<BetaMessage> & { text?: string } = {}): BetaMessage {
  const { text = JSON.stringify(decision), ...rest } = overrides;
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 60 },
    ...rest,
  } as BetaMessage;
}

function fakeClient(impl: (params: MessageCreateParamsNonStreaming) => Promise<BetaMessage>) {
  const create = vi.fn((params: MessageCreateParamsNonStreaming, _opts?: { signal?: AbortSignal }) => impl(params));
  return { client: { beta: { messages: { create } } } as ClaudeClient, create };
}

async function failure(promise: Promise<unknown>): Promise<AgentError> {
  const err = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AgentError);
  return err as AgentError;
}

describe('claude provider', () => {
  const signal = new AbortController().signal;

  it('sends the structured-output request and returns the parsed decision with usage', async () => {
    const { client, create } = fakeClient(async () => message());
    const result = await createClaudeProvider(client).decide(input, signal);

    expect(result.decision).toEqual(decision);
    expect(result.raw).toBe(JSON.stringify(decision));
    expect(result).toMatchObject({ input_tokens: 900, output_tokens: 60 });

    const [params, opts] = create.mock.calls[0]!;
    expect(opts).toEqual({ signal });
    expect(params).toMatchObject({
      model: config.claudeModel,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: config.claudeEffort, format: { type: 'json_schema' } },
    });
    expect(params.output_config!.format!.schema).toEqual(toClaudeSchema(decisionJsonSchema));
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]!.role).toBe('user');
    expect(String(params.system)).toContain('리그 규칙');
  });

  it('keeps closed objects and enums in the Claude schema and moves unsupported limits to descriptions', () => {
    type Node = { [key: string]: unknown; properties: Record<string, Node>; items: Node };
    const schema = toClaudeSchema(decisionJsonSchema) as Node;
    expect(schema.additionalProperties).toBe(false);
    const item = schema.properties.orders.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['symbol', 'side', 'quantity', 'reason']);
    expect(item.properties.side.enum).toEqual(['BUY', 'SELL']);
    expect(item.properties.quantity).toEqual({ type: 'integer', description: '{minimum: 1}' });
    expect(schema.properties.orders.maxItems).toBeUndefined();
    expect(schema.properties.orders.description).toContain('maxItems: 5');
  });

  it('turns a refusal into an error', async () => {
    const { client } = fakeClient(async () => message({ stop_reason: 'refusal', text: '' }));
    const err = await failure(createClaudeProvider(client).decide(input, signal));
    expect(err.kind).toBe('error');
    expect(err.message).toContain('refusal');
  });

  it('reports invalid JSON and schema violations as invalid, keeping the raw text', async () => {
    const { client } = fakeClient(async () => message({ text: '{"market_view": "중단된 응답' }));
    const err = await failure(createClaudeProvider(client).decide(input, signal));
    expect(err.kind).toBe('invalid');
    expect(err.raw).toBe('{"market_view": "중단된 응답');

    const extra = fakeClient(async () => message({ text: JSON.stringify({ ...decision, note: 'x' }) }));
    expect((await failure(createClaudeProvider(extra.client).decide(input, signal))).kind).toBe('invalid');
  });

  it('reports a response without a text block as invalid', async () => {
    const { client } = fakeClient(async () => message({ content: [], stop_reason: 'max_tokens' }));
    const err = await failure(createClaudeProvider(client).decide(input, signal));
    expect(err.kind).toBe('invalid');
    expect(err.message).toContain('max_tokens');
  });

  it('maps typed SDK errors to readable messages', async () => {
    const cases: [Error, string][] = [
      [new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers()), 'rate_limited'],
      [new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers()), 'auth_failed'],
      [new Anthropic.APIConnectionError({ message: 'offline' }), 'connection_failed'],
      [new Anthropic.InternalServerError(500, undefined, 'oops', new Headers()), 'api_error 500'],
    ];
    for (const [thrown, code] of cases) {
      const { client } = fakeClient(async () => {
        throw thrown;
      });
      const err = await failure(createClaudeProvider(client).decide(input, signal));
      expect(err.kind).toBe('error');
      expect(err.message).toContain(code);
    }
  });

  it('fails without an API key when no client is injected', async () => {
    const saved = config.anthropicApiKey;
    config.anthropicApiKey = undefined;
    try {
      const err = await failure(createClaudeProvider().decide(input, signal));
      expect(err.message).toContain('ANTHROPIC_API_KEY');
    } finally {
      config.anthropicApiKey = saved;
    }
  });
});

describe('ollama provider', () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeFetch(status: number, body: unknown) {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
  }

  it('posts an OpenAI-compatible json_schema request and strips <think> blocks', async () => {
    const content = `<think>잠깐 생각</think>\n${JSON.stringify(decision)}`;
    const doFetch = fakeFetch(200, {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 700, completion_tokens: 50 },
    });
    const provider = createOllamaProvider({ baseUrl: 'http://ollama:11434/', model: 'qwen3:8b', fetch: doFetch });
    const signal = new AbortController().signal;
    const result = await provider.decide(input, signal);

    expect(result.decision).toEqual(decision);
    expect(result).toMatchObject({ raw: content, input_tokens: 700, output_tokens: 50 });
    const [url, init] = doFetch.mock.calls[0]!;
    expect(url).toBe('http://ollama:11434/v1/chat/completions');
    expect(init!.signal).toBe(signal);
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      model: 'qwen3:8b',
      temperature: 0,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: decisionJsonSchema } },
    });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
  });

  it('maps HTTP failures to errors and bad content to invalid', async () => {
    const signal = new AbortController().signal;
    const down = createOllamaProvider({ baseUrl: 'http://o', fetch: fakeFetch(500, 'model not loaded') });
    const err = await failure(down.decide(input, signal));
    expect(err).toMatchObject({ kind: 'error' });
    expect(err.message).toContain('ollama_http_500');

    const garbage = createOllamaProvider({
      baseUrl: 'http://o',
      fetch: fakeFetch(200, { choices: [{ message: { content: '매수하세요!' } }] }),
    });
    expect((await failure(garbage.decide(input, signal))).kind).toBe('invalid');

    const refused = createOllamaProvider({
      baseUrl: 'http://o',
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    expect((await failure(refused.decide(input, signal))).message).toContain('connection_failed');
  });
});
