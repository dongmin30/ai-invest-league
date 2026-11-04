import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import('../src/config')).config;
}

describe('config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps data in server/data unless DATA_DIR is set', async () => {
    expect((await loadConfig({ DATA_DIR: undefined })).dataDir).toBe(path.join(repoRoot, 'server', 'data'));
    expect((await loadConfig({ DATA_DIR: '  ' })).dataDir).toBe(path.join(repoRoot, 'server', 'data'));
  });

  it('resolves a relative DATA_DIR against the repo root and keeps absolute ones', async () => {
    expect((await loadConfig({ DATA_DIR: 'server/data/smoke' })).dataDir).toBe(path.join(repoRoot, 'server', 'data', 'smoke'));
    const absolute = path.join(repoRoot, 'elsewhere');
    expect((await loadConfig({ DATA_DIR: absolute })).dataDir).toBe(absolute);
  });

  it('parses TRUST_PROXY as a boolean or trusted addresses', async () => {
    expect((await loadConfig({ TRUST_PROXY: undefined })).trustProxy).toBe(false);
    expect((await loadConfig({ TRUST_PROXY: 'false' })).trustProxy).toBe(false);
    expect((await loadConfig({ TRUST_PROXY: 'true' })).trustProxy).toBe(true);
    expect((await loadConfig({ TRUST_PROXY: '1' })).trustProxy).toBe(true);
    await expect(loadConfig({ TRUST_PROXY: '2' })).rejects.toThrow(/TRUST_PROXY/);
    expect((await loadConfig({ TRUST_PROXY: ' Loopback ' })).trustProxy).toBe('loopback');
    expect((await loadConfig({ TRUST_PROXY: '127.0.0.1, ::1' })).trustProxy).toBe('127.0.0.1, ::1');
    expect((await loadConfig({ TRUST_PROXY: '127.0.0.1' })).trustProxy).toBe('127.0.0.1');
    await expect(loadConfig({ TRUST_PROXY: 'every$thing' })).rejects.toThrow(/TRUST_PROXY/);
  });
});
