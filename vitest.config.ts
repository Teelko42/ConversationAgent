import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Alias the workspace packages to their source so tests run without a build step.
const pkg = (name: string, sub: string) =>
  fileURLToPath(new URL(`./packages/${sub}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@aizen/contracts': pkg('@aizen/contracts', 'contracts'),
      '@aizen/accounts': pkg('@aizen/accounts', 'accounts'),
      '@aizen/adapter-d16': pkg('@aizen/adapter-d16', 'adapter-d16'),
      '@aizen/seam-supersede': pkg('@aizen/seam-supersede', 'seam-supersede'),
      '@aizen/seam-kg-resync': pkg('@aizen/seam-kg-resync', 'seam-kg-resync'),
      '@aizen/llm-gateway': pkg('@aizen/llm-gateway', 'llm-gateway'),
      '@aizen/research': pkg('@aizen/research', 'research'),
      '@aizen/edge-gateway': pkg('@aizen/edge-gateway', 'edge-gateway'),
      '@aizen/capture': pkg('@aizen/capture', 'capture'),
      '@aizen/stt-worker': pkg('@aizen/stt-worker', 'stt-worker'),
      '@aizen/intel-worker': pkg('@aizen/intel-worker', 'intel-worker'),
      '@aizen/web-client': pkg('@aizen/web-client', 'web-client'),
      '@aizen/session-conductor': pkg('@aizen/session-conductor', 'session-conductor'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
  },
});
