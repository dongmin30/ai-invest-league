import { defineConfig } from 'vitest/config';

// Vitest sets process.env.VITEST, which makes src/db/db.ts open ':memory:'.
// Each test file runs in its own worker module graph, so every file gets a fresh,
// isolated database. Call resetDb() in beforeEach for per-test isolation.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    isolate: true,
  },
});
