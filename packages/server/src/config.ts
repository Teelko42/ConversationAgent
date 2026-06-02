/**
 * App configuration, loaded from `.env` at the repo root (dotenv). Keys are the
 * ones documented in `.env.example`. Empty strings (an unfilled template line)
 * are treated as absent, so "is this provider configured?" is a simple presence
 * check. NO secret is ever logged — only whether each is set.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { TENANT } from '@aizen/contracts';

// Load .env from the repo root regardless of the process CWD (this file lives at
// packages/server/src/, so the root is four levels up).
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
loadDotenv({ path: resolve(repoRoot, '.env') });

/** Coerce an env var to a trimmed value, mapping '' / undefined → undefined. */
function envOpt(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export interface AppConfig {
  port: number;
  tenantId: string;
  anthropicApiKey?: string;
  deepgramApiKey?: string;
  webSearchProvider: string;
  tavilyApiKey?: string;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(envOpt('PORT') ?? 5173),
    tenantId: envOpt('TENANT_ID') ?? TENANT,
    anthropicApiKey: envOpt('ANTHROPIC_API_KEY'),
    deepgramApiKey: envOpt('DEEPGRAM_API_KEY'),
    webSearchProvider: envOpt('WEB_SEARCH_PROVIDER') ?? 'tavily',
    tavilyApiKey: envOpt('TAVILY_API_KEY'),
  };
}

/** Which real providers are active (for the startup banner + the client UI). */
export interface ProviderStatus {
  stt: 'deepgram' | 'stub';
  llm: 'anthropic' | 'stub';
  search: 'tavily' | 'off';
}

export function providerStatus(cfg: AppConfig): ProviderStatus {
  return {
    stt: cfg.deepgramApiKey ? 'deepgram' : 'stub',
    llm: cfg.anthropicApiKey ? 'anthropic' : 'stub',
    search: cfg.webSearchProvider === 'tavily' && cfg.tavilyApiKey ? 'tavily' : 'off',
  };
}
