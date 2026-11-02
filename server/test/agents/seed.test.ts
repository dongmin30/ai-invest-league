import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkOllama, seedAgents } from '../../src/agents/seed';
import { config } from '../../src/config';
import { db, resetDb } from '../../src/db/db';

const saved = { key: config.anthropicApiKey, url: config.ollamaBaseUrl, model: config.ollamaModel };

function tags(models: string[]) {
  return vi.fn(async () => new Response(JSON.stringify({ models: models.map((name) => ({ name, model: name })) })));
}

function agents() {
  return db.prepare('SELECT name, provider, model, enabled, disabled_reason, strategy_prompt FROM agents ORDER BY id').all() as {
    name: string;
    provider: string;
    model: string;
    enabled: number;
    disabled_reason: string | null;
    strategy_prompt: string;
  }[];
}

beforeEach(() => {
  resetDb();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  config.anthropicApiKey = saved.key;
  config.ollamaBaseUrl = saved.url;
  config.ollamaModel = saved.model;
  vi.restoreAllMocks();
});

describe('seedAgents', () => {
  it('creates the four agents and disables LLM agents that are not configured', async () => {
    config.anthropicApiKey = undefined;
    config.ollamaBaseUrl = undefined;
    const doFetch = vi.fn();
    await seedAgents(doFetch);

    expect(doFetch).not.toHaveBeenCalled();
    expect(agents()).toEqual([
      expect.objectContaining({ name: 'Claude 트레이더', provider: 'claude', model: config.claudeModel, enabled: 0, disabled_reason: 'ANTHROPIC_API_KEY 미설정' }),
      expect.objectContaining({ name: '로컬 LLM 트레이더', provider: 'ollama', model: config.ollamaModel, enabled: 0, disabled_reason: 'OLLAMA_BASE_URL 미설정' }),
      expect.objectContaining({ name: '기준선 봇', provider: 'rule', model: 'baseline', enabled: 1, disabled_reason: null }),
      expect.objectContaining({ name: '모멘텀 봇', provider: 'rule', model: 'momentum', enabled: 1, disabled_reason: null }),
    ]);
  });

  it('enables configured agents and upserts by name without losing ids or edited prompts', async () => {
    config.anthropicApiKey = undefined;
    config.ollamaBaseUrl = undefined;
    await seedAgents(vi.fn());
    const before = db.prepare('SELECT id, name FROM agents ORDER BY id').all();
    db.prepare("UPDATE agents SET strategy_prompt = '배당주 위주' WHERE provider = 'claude'").run();

    config.anthropicApiKey = 'sk-test';
    config.ollamaBaseUrl = 'http://localhost:11434';
    config.ollamaModel = 'qwen3:8b';
    const doFetch = tags(['qwen3:8b', 'llama3:latest']);
    await seedAgents(doFetch);

    expect(db.prepare('SELECT id, name FROM agents ORDER BY id').all()).toEqual(before);
    const rows = agents();
    expect(rows[0]).toMatchObject({ enabled: 1, disabled_reason: null, strategy_prompt: '배당주 위주' });
    expect(rows[1]).toMatchObject({ enabled: 1, disabled_reason: null });
    expect(doFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});

describe('checkOllama', () => {
  it('requires the server to answer and the model to be pulled', async () => {
    expect(await checkOllama('http://o', 'qwen3:8b', tags(['qwen3:8b']))).toEqual({ ok: true, reason: null });
    expect(await checkOllama('http://o', 'llama3', tags(['llama3:latest']))).toEqual({ ok: true, reason: null });

    const missing = await checkOllama('http://o', 'qwen3:8b', tags(['llama3:latest']));
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('ollama pull qwen3:8b');

    const down = await checkOllama('http://o', 'qwen3:8b', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    expect(down).toEqual({ ok: false, reason: 'Ollama 서버에 연결할 수 없습니다 (http://o)' });

    const http = await checkOllama('http://o', 'qwen3:8b', vi.fn(async () => new Response('', { status: 503 })));
    expect(http.reason).toContain('503');
  });
});
