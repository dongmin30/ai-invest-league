import { config } from '../../config';
import { buildPrompt } from '../prompt';
import { decisionJsonSchema } from '../schema';
import { AgentError, type LLMProvider } from '../types';
import { parseDecision } from './parse';

export interface OllamaOptions {
  /** Defaults to config.ollamaBaseUrl at call time. */
  baseUrl?: string;
  /** Defaults to config.ollamaModel at call time. */
  model?: string;
  fetch?: typeof fetch;
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Ollama's OpenAI-compatible chat endpoint with a strict JSON-schema response format. */
export function createOllamaProvider(opts: OllamaOptions = {}): LLMProvider {
  return {
    async decide(input, signal) {
      const baseUrl = (opts.baseUrl ?? config.ollamaBaseUrl)?.replace(/\/+$/, '');
      if (!baseUrl) throw new AgentError('error', 'OLLAMA_BASE_URL 미설정');
      const { system, user } = buildPrompt(input);
      const doFetch = opts.fetch ?? fetch;

      const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opts.model ?? config.ollamaModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'decision', schema: decisionJsonSchema, strict: true },
          },
          temperature: 0,
          stream: false,
        }),
        signal,
      }).catch((err: unknown) => {
        if (signal.aborted) throw err;
        throw new AgentError('error', `connection_failed: Ollama 연결 실패 (${(err as Error).message ?? err})`);
      });

      const body = await res.text();
      if (!res.ok) {
        throw new AgentError('error', `ollama_http_${res.status}: ${body.slice(0, 300)}`);
      }
      let completion: ChatCompletion;
      try {
        completion = JSON.parse(body) as ChatCompletion;
      } catch {
        throw new AgentError('error', 'Ollama 응답을 해석할 수 없습니다.', body);
      }
      const content = completion.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new AgentError('invalid', '응답에 내용이 없습니다.', body);
      }
      return {
        decision: parseDecision(content),
        raw: content,
        input_tokens: completion.usage?.prompt_tokens,
        output_tokens: completion.usage?.completion_tokens,
      };
    },
  };
}
