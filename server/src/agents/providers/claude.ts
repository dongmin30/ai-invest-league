import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { config } from '../../config';
import { buildPrompt } from '../prompt';
import { decisionJsonSchema } from '../schema';
import { AgentError, type LLMProvider } from '../types';
import { parseDecision } from './parse';

/** The slice of the SDK client this provider uses; tests inject a fake. */
export interface ClaudeClient {
  beta: {
    messages: {
      create(params: MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<BetaMessage>;
    };
  };
}

const MAX_TOKENS = 2000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Structured outputs reject numeric, string-length and most array-size keywords, so they
// are moved into the description as hints. DecisionSchema enforces them on the reply.
const UNSUPPORTED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
];

export function toClaudeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toClaudeSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  const hints: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.includes(key) || (key === 'minItems' && value !== 0 && value !== 1)) {
      hints.push(`${key}: ${JSON.stringify(value)}`);
    } else if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toClaudeSchema(v)]));
    } else {
      out[key] = key === 'items' || key === 'anyOf' || key === 'allOf' ? toClaudeSchema(value) : value;
    }
  }
  if (hints.length > 0) {
    out.description = [out.description, `{${hints.join(', ')}}`].filter(Boolean).join('\n\n');
  }
  return out;
}

const outputSchema = toClaudeSchema(decisionJsonSchema) as Record<string, unknown>;

let sharedClient: { key: string; client: ClaudeClient } | undefined;

function defaultClient(): ClaudeClient {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) throw new AgentError('error', 'ANTHROPIC_API_KEY 미설정');
  if (sharedClient?.key !== apiKey) sharedClient = { key: apiKey, client: new Anthropic({ apiKey }) };
  return sharedClient.client;
}

function mapSdkError(err: unknown): unknown {
  if (err instanceof AgentError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.RateLimitError) return new AgentError('error', `rate_limited: 요청 한도 초과 (${err.message})`);
  if (err instanceof Anthropic.AuthenticationError) return new AgentError('error', `auth_failed: API 키 인증 실패 (${err.message})`);
  if (err instanceof Anthropic.APIConnectionError) return new AgentError('error', `connection_failed: API 연결 실패 (${err.message})`);
  if (err instanceof Anthropic.APIError) return new AgentError('error', `api_error ${err.status ?? ''}: ${err.message}`.trim());
  return err;
}

/** `client` defaults to an SDK client built from config.anthropicApiKey on first use. */
export function createClaudeProvider(client?: ClaudeClient): LLMProvider {
  return {
    async decide(input, signal) {
      const { system, user } = buildPrompt(input);
      const params = {
        model: config.claudeModel,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        output_config: { effort: config.claudeEffort, format: { type: 'json_schema', schema: outputSchema } },
        system,
        messages: [{ role: 'user', content: user }],
      } satisfies MessageCreateParamsNonStreaming;

      let response: BetaMessage;
      try {
        response = await (client ?? defaultClient()).beta.messages.create(params, { signal });
      } catch (err) {
        throw mapSdkError(err);
      }

      const usage = { input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens };
      if (response.stop_reason === 'refusal') {
        throw new AgentError('error', 'refusal: 모델이 응답을 거부했습니다.');
      }
      const text = response.content.find((b) => b.type === 'text');
      if (!text || text.type !== 'text') {
        throw new AgentError('invalid', `응답에 텍스트가 없습니다 (stop_reason: ${response.stop_reason ?? 'null'}).`);
      }
      return { decision: parseDecision(text.text), raw: text.text, ...usage };
    },
  };
}
