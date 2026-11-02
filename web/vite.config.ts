import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sharedDir = fileURLToPath(new URL('../shared', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': sharedDir },
  },
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // SSE (/api/stream) is a long-lived response; disable proxy timeouts so it stays open.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
