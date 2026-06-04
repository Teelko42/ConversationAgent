/**
 * Build the configured set of `AuthProvider`s from environment-style settings —
 * the BD-03 key-gated seam, exactly like `makeWebSearchProvider` (@aizen/research)
 * and the STT/LLM provider selection: which providers are real is decided purely
 * by which keys are present, with no separate "auth build".
 *
 *   • Google keys present     → real Google provider.
 *   • Microsoft keys present  → real Microsoft Entra provider.
 *   • NEITHER present         → only `StubAuthProvider`, so the app still boots and
 *                               the account/quota features are demoable with no IdP
 *                               (and the anonymous/demo flow is unchanged).
 *
 * The stub is also always available as a fallback kind when at least one real
 * provider is configured but a caller asks for `stub` explicitly — harmless, and
 * it keeps local testing trivial.
 */
import type { AuthProviderKind } from '@aizen/contracts';
import { StubAuthProvider, type AuthProvider } from './auth-provider.js';
import { GOOGLE_ENDPOINTS, OAuthProvider, microsoftEndpoints } from './provider-oauth.js';

export interface AuthConfig {
  google?: { clientId?: string; clientSecret?: string };
  microsoft?: { clientId?: string; clientSecret?: string; tenant?: string };
}

export interface AuthSeam {
  /** Resolve a provider by kind, or undefined if it is not enabled. */
  get(kind: string): AuthProvider | undefined;
  /** The provider kinds offered for sign-in (drives the UI's sign-in menu). */
  enabled: AuthProviderKind[];
  /** 'real' once at least one IdP is configured; 'stub' when running key-less. */
  mode: 'real' | 'stub';
}

export function makeAuthProviders(cfg: AuthConfig = {}): AuthSeam {
  const providers = new Map<string, AuthProvider>();

  if (cfg.google?.clientId && cfg.google?.clientSecret) {
    providers.set(
      'google',
      new OAuthProvider({
        kind: 'google',
        clientId: cfg.google.clientId,
        clientSecret: cfg.google.clientSecret,
        endpoints: GOOGLE_ENDPOINTS,
      }),
    );
  }

  if (cfg.microsoft?.clientId && cfg.microsoft?.clientSecret) {
    providers.set(
      'microsoft',
      new OAuthProvider({
        kind: 'microsoft',
        clientId: cfg.microsoft.clientId,
        clientSecret: cfg.microsoft.clientSecret,
        endpoints: microsoftEndpoints(cfg.microsoft.tenant),
      }),
    );
  }

  const real = providers.size > 0;
  // The stub is always registered so `get('stub')` works; it is only OFFERED for
  // sign-in (listed in `enabled`) when no real provider is configured.
  providers.set('stub', new StubAuthProvider());

  const enabled: AuthProviderKind[] = real
    ? ([...providers.keys()].filter((k) => k !== 'stub') as AuthProviderKind[])
    : ['stub'];

  return {
    get: (kind) => providers.get(kind),
    enabled,
    mode: real ? 'real' : 'stub',
  };
}
