/**
 * @aizen/accounts — the account system (New_Feature.md). A first-class account
 * layer added AROUND the existing pipeline without changing it: OAuth sign-in
 * behind a key-gated seam (BD-03), accounts/identities/resources persisted behind
 * a swappable repository, per-tier entitlements, and fail-closed resource quota.
 *
 *   • AuthProvider seam    — Stub (no keys, demoable) + Google/Microsoft Entra.
 *   • AccountRepository    — InMemory + node:sqlite + PostgreSQL (Azure Phase-1+).
 *   • Entitlements/quota   — tier-keyed caps (team-10 §1.2/§5.3), hard-reject.
 *   • CookieSigner         — signed, httpOnly server-side session cookies.
 *   • AccountService       — the one business-logic surface the server calls.
 */
export * from './auth-provider.js';
export {
  OAuthProvider,
  GOOGLE_ENDPOINTS,
  microsoftEndpoints,
  type OAuthEndpoints,
  type OAuthProviderOptions,
} from './provider-oauth.js';
export { makeAuthProviders, type AuthConfig, type AuthSeam } from './make-auth.js';

export {
  type AccountRepository,
  InMemoryAccountRepository,
} from './repository.js';
export { SqliteAccountRepository, openAccountDb } from './repository-sqlite.js';
export { PgAccountRepository, type PgOpenOptions } from './repository-postgres.js';

export {
  DEFAULT_ENTITLEMENTS,
  entitlementFor,
  retentionDeadlineUs,
} from './entitlements.js';
export { QuotaExceededError, checkQuota, SourceQuotaExceededError, checkSourceQuota } from './quota.js';
export {
  CookieSigner,
  parseCookies,
  serializeCookie,
  clearCookie,
  type CookieSignerOptions,
  type SetCookieOptions,
} from './cookies.js';
export {
  AccountService,
  type AccountServiceOptions,
  type ArtifactInput,
  type SaveResourceInput,
  type SaveSourceInput,
} from './service.js';
