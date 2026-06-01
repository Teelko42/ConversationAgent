import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Alias the workspace packages to their source so tests run without a build step.
const pkg = (name: string, sub: string) =>
  fileURLToPath(new URL(`./packages/${sub}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@aizen/contracts': pkg('@aizen/contracts', 'contracts'),
      '@aizen/adapter-d16': pkg('@aizen/adapter-d16', 'adapter-d16'),
      '@aizen/seam-supersede': pkg('@aizen/seam-supersede', 'seam-supersede'),
      '@aizen/seam-kg-resync': pkg('@aizen/seam-kg-resync', 'seam-kg-resync'),
      '@aizen/llm-gateway': pkg('@aizen/llm-gateway', 'llm-gateway'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
  },
});
