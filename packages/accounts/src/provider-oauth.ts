/**
 * Real OAuth 2.0 / OIDC providers behind the `AuthProvider` seam — the BD-03
 * swap-in for `StubAuthProvider`: same interface, real network. Two presets ship
 * (New_Feature.md §1): **Google** and **Microsoft Entra (Azure AD)**. Both speak
 * the same Authorization-Code + PKCE handshake, so one class is parameterized by
 * the provider's endpoints.
 *
 * PKCE (RFC 7636): we generate a high-entropy `code_verifier`, send its SHA-256
 * `code_challenge` on the authorize redirect, and replay the verifier on token
 * exchange — so a stolen auth code is useless without the verifier (which never
 * leaves our signed cookie). After exchange we read the OIDC **userinfo** endpoint
 * to get the stable `sub` + email/name; this avoids JWT signature verification in
 * Phase 0 while still using only the provider's own trusted endpoint.
 *
 * Testability mirrors `DeepgramSttProvider` / `TavilyWebSearchProvider`: `fetch`
 * and the entropy source are injectable, so the whole flow is asserted with an
 * injected client and zero network (see `auth-provider.test.ts`).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AuthProviderKind } from '@aizen/contracts';
import type {
  AuthProvider,
  AuthRedirect,
  AuthorizeOptions,
  ExchangeOptions,
  ExternalIdentity,
} from './auth-provider.js';

/** The IdP-specific endpoints + scopes one OAuth/OIDC provider needs. */
export interface OAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
}

export interface OAuthProviderOptions {
  kind: Exclude<AuthProviderKind, 'stub'>;
  clientId: string;
  clientSecret: string;
  endpoints: OAuthEndpoints;
  /** Inject a fetch (tests). Defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
  /** Inject entropy (tests). Returns N random bytes; defaults to `randomBytes`. */
  randomBytesImpl?: (n: number) => Buffer;
  /** Abort a token/userinfo request after this many ms (default 9s). */
  timeoutMs?: number;
}

/** base64url with no padding, per RFC 7636. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Token-endpoint response (the bits we read). */
interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** OIDC userinfo response (Google + Entra both return these). */
interface UserInfoResponse {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

export class OAuthProvider implements AuthProvider {
  readonly kind: AuthProviderKind;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly endpoints: OAuthEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly randomBytesImpl: (n: number) => Buffer;
  private readonly timeoutMs: number;

  constructor(opts: OAuthProviderOptions) {
    if (!opts.clientId || !opts.clientSecret) {
      throw new Error(`OAuthProvider(${opts.kind}): clientId and clientSecret are required`);
    }
    this.kind = opts.kind;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.endpoints = opts.endpoints;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.randomBytesImpl = opts.randomBytesImpl ?? randomBytes;
    this.timeoutMs = opts.timeoutMs ?? 9000;
  }

  async authorize(opts: AuthorizeOptions): Promise<AuthRedirect> {
    const state = base64url(this.randomBytesImpl(16));
    const codeVerifier = base64url(this.randomBytesImpl(32));
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: opts.redirectUri,
      scope: this.endpoints.scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      // Force an account chooser + a refreshable session (Google honours these;
      // Entra ignores the unknown ones).
      access_type: 'offline',
      prompt: 'select_account',
    });
    return { url: `${this.endpoints.authUrl}?${params.toString()}`, state, codeVerifier };
  }

  async exchange(opts: ExchangeOptions): Promise<ExternalIdentity> {
    const token = await this.postForm<TokenResponse>(this.endpoints.tokenUrl, {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: opts.codeVerifier,
    });
    if (token.error || !token.access_token) {
      throw new Error(
        `oauth token exchange failed (${this.kind}): ${token.error ?? 'no access_token'}${
          token.error_description ? ` — ${token.error_description}` : ''
        }`,
      );
    }

    const info = await this.getJson<UserInfoResponse>(this.endpoints.userInfoUrl, token.access_token);
    const subject = info.sub;
    if (!subject) {
      throw new Error(`oauth userinfo missing 'sub' (${this.kind})`);
    }
    return {
      provider: this.kind,
      subject,
      email: info.email ?? info.preferred_username ?? null,
      displayName: info.name ?? info.email ?? null,
    };
  }

  /** POST application/x-www-form-urlencoded, bounded by `timeoutMs`. */
  private async postForm<T>(url: string, body: Record<string, string>): Promise<T> {
    const res = await this.bounded((signal) =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(body).toString(),
        signal,
      }),
    );
    if (!res.ok) throw new Error(`oauth POST ${url} failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  /** GET JSON with a Bearer token, bounded by `timeoutMs`. */
  private async getJson<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.bounded((signal) =>
      this.fetchImpl(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal,
      }),
    );
    if (!res.ok) throw new Error(`oauth GET ${url} failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  /** Run a fetch with an abort timer so a stalled IdP can't hang sign-in. */
  private async bounded(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref?: () => void }).unref!();
    }
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Google OIDC endpoints (accounts.google.com). */
export const GOOGLE_ENDPOINTS: OAuthEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  scope: 'openid email profile',
};

/**
 * Microsoft Entra (Azure AD) v2.0 endpoints. `tenant` is the directory (default
 * `common` for multi-tenant + personal Microsoft accounts; set a tenant GUID or
 * domain for single-tenant). New_Feature.md [ASSUMPTION — Azure stack ⇒ Entra].
 */
export function microsoftEndpoints(tenant = 'common'): OAuthEndpoints {
  return {
    authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    userInfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
  };
}
