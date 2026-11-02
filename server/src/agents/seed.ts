import type { AgentProvider } from '../../../shared/api-types';
import { config } from '../config';
import { sql } from '../engine/store';

const OLLAMA_CHECK_MS = 2000;

interface SeedAgent {
  name: string;
  provider: AgentProvider;
  model: string;
  description: string;
  strategy_prompt: string;
  enabled: boolean;
  disabled_reason: string | null;
}

export interface OllamaCheck {
  ok: boolean;
  reason: string | null;
}

/** `GET {baseUrl}/api/tags` within 2 s, and the configured model must be pulled. */
export async function checkOllama(
  baseUrl: string | undefined,
  model: string,
  doFetch: typeof fetch = fetch,
): Promise<OllamaCheck> {
  if (!baseUrl) return { ok: false, reason: 'OLLAMA_BASE_URL 미설정' };
  try {
    const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_CHECK_MS) });
    if (!res.ok) return { ok: false, reason: `Ollama 서버 응답 오류 (HTTP ${res.status})` };
    const body = (await res.json().catch(() => ({}))) as { models?: { name?: string; model?: string }[] };
    const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => Boolean(n));
    const wanted = model.includes(':') ? [model] : [model, `${model}:latest`];
    if (!names.some((n) => wanted.includes(n))) {
      return { ok: false, reason: `Ollama에 ${model} 모델이 없습니다 (ollama pull ${model})` };
    }
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: `Ollama 서버에 연결할 수 없습니다 (${baseUrl})` };
  }
}

async function seedList(doFetch: typeof fetch): Promise<SeedAgent[]> {
  const ollama = await checkOllama(config.ollamaBaseUrl, config.ollamaModel, doFetch);
  return [
    {
      name: 'Claude 트레이더',
      provider: 'claude',
      model: config.claudeModel,
      description: 'Anthropic Claude가 시세와 포트폴리오를 읽고 직접 매매를 결정합니다.',
      strategy_prompt: '리그 기간 안에 위험 대비 수익을 높이세요. 근거가 약하면 거래하지 말고, 한 종목에 몰빵하지 마세요.',
      enabled: Boolean(config.anthropicApiKey),
      disabled_reason: config.anthropicApiKey ? null : 'ANTHROPIC_API_KEY 미설정',
    },
    {
      name: '로컬 LLM 트레이더',
      provider: 'ollama',
      model: config.ollamaModel,
      description: 'Ollama로 내 컴퓨터에서 실행하는 오픈 모델이 매매를 결정합니다.',
      strategy_prompt: '리그 기간 안에 위험 대비 수익을 높이세요. 확신이 없으면 관망하세요.',
      enabled: ollama.ok,
      disabled_reason: ollama.reason,
    },
    {
      name: '기준선 봇',
      provider: 'rule',
      model: 'baseline',
      description: '첫 판단에서 거래량 상위 10종목을 동일 비중으로 사서 끝까지 보유하는 비교 기준입니다.',
      strategy_prompt: '',
      enabled: true,
      disabled_reason: null,
    },
    {
      name: '모멘텀 봇',
      provider: 'rule',
      model: 'momentum',
      description: '전일 대비 -2% 미만 종목은 팔고, +1% 넘게 오른 상위 2종목을 자산의 20% 이내로 삽니다.',
      strategy_prompt: '',
      enabled: true,
      disabled_reason: null,
    },
  ];
}

/**
 * Upserts the built-in agents by name. Provider, model, description and availability are
 * refreshed on every boot; an edited strategy_prompt and the markets column are kept.
 */
export async function seedAgents(doFetch: typeof fetch = fetch): Promise<void> {
  const agents = await seedList(doFetch);
  const upsert = sql(
    `INSERT INTO agents (name, provider, model, description, strategy_prompt, markets, enabled, disabled_reason)
     VALUES (?, ?, ?, ?, ?, 'KR,US', ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       description = excluded.description,
       enabled = excluded.enabled,
       disabled_reason = excluded.disabled_reason`,
  );
  for (const a of agents) {
    upsert.run(a.name, a.provider, a.model, a.description, a.strategy_prompt, a.enabled ? 1 : 0, a.disabled_reason);
  }
  for (const a of agents.filter((x) => !x.enabled)) {
    console.warn(`[agents] ${a.name} 비활성화: ${a.disabled_reason}`);
  }
}
