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

  // --- accounts / OAuth (New_Feature.md) — all optional; absent ⇒ Stub auth ---
  googleClientId?: string;
  googleClientSecret?: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  /** Entra directory: 'common' (default), 'organizations', or a tenant GUID/domain. */
  microsoftTenant: string;
  /** HMAC secret for signed session cookies. Absent ⇒ an ephemeral per-process one. */
  sessionCookieSecret?: string;
  /** SQLite file for accounts/resources. Absent ⇒ '<repoRoot>/.data/accounts.db'. */
  accountsDbPath: string;
  /**
   * PostgreSQL connection URL for accounts/resources (the Azure Phase-1+ store,
   * e.g. `postgresql://user:pwd@host:5432/aizen?sslmode=require`). When set, it is
   * preferred over SQLite; if it can't connect at boot the app falls back to
   * SQLite/in-memory (BD-03 fail-open). Absent ⇒ SQLite.
   *
   * Forced to `undefined` when `USE_LOCAL_DB` is set, so you can keep secrets in
   * Azure Key Vault while keeping the database LOCAL (SQLite) — even if a
   * `DATABASE_URL` is still present in `.env`. See AZURE_SETUP.md.
   */
  databaseUrl?: string;
}

/** Resolve the accounts DB path under a gitignored `.data/` dir at the repo root. */
function defaultAccountsDbPath(): string {
  return resolve(repoRoot, '.data', 'accounts.db');
}

export function loadConfig(): AppConfig {
  return {
    port: Number(envOpt('PORT') ?? 5173),
    tenantId: envOpt('TENANT_ID') ?? TENANT,
    anthropicApiKey: envOpt('ANTHROPIC_API_KEY'),
    deepgramApiKey: envOpt('DEEPGRAM_API_KEY'),
    webSearchProvider: envOpt('WEB_SEARCH_PROVIDER') ?? 'tavily',
    tavilyApiKey: envOpt('TAVILY_API_KEY'),
    googleClientId: envOpt('GOOGLE_CLIENT_ID'),
    googleClientSecret: envOpt('GOOGLE_CLIENT_SECRET'),
    microsoftClientId: envOpt('MICROSOFT_CLIENT_ID'),
    microsoftClientSecret: envOpt('MICROSOFT_CLIENT_SECRET'),
    microsoftTenant: envOpt('MICROSOFT_TENANT') ?? 'common',
    sessionCookieSecret: envOpt('SESSION_COOKIE_SECRET'),
    accountsDbPath: envOpt('ACCOUNTS_DB') ?? defaultAccountsDbPath(),
    // USE_LOCAL_DB forces the local SQLite store even if DATABASE_URL is set, so you
    // can run "secrets in Azure Key Vault, database local" (start-local-azure-secrets.ps1).
    databaseUrl: envOpt('USE_LOCAL_DB') ? undefined : envOpt('DATABASE_URL'),
  };
}

/** Which real providers are active (for the startup banner + the client UI). */
export interface ProviderStatus {
  stt: 'deepgram' | 'stub';
  llm: 'anthropic' | 'stub';
  search: 'tavily' | 'off';
  /** Sign-in: which OAuth IdPs are configured ('stub' when none → demo accounts). */
  auth: 'google+microsoft' | 'google' | 'microsoft' | 'stub';
}

export function providerStatus(cfg: AppConfig): ProviderStatus {
  const google = !!(cfg.googleClientId && cfg.googleClientSecret);
  const microsoft = !!(cfg.microsoftClientId && cfg.microsoftClientSecret);
  const auth: ProviderStatus['auth'] =
    google && microsoft ? 'google+microsoft' : google ? 'google' : microsoft ? 'microsoft' : 'stub';
  return {
    stt: cfg.deepgramApiKey ? 'deepgram' : 'stub',
    llm: cfg.anthropicApiKey ? 'anthropic' : 'stub',
    search: cfg.webSearchProvider === 'tavily' && cfg.tavilyApiKey ? 'tavily' : 'off',
    auth,
  };
}
