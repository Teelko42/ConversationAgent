/**
 * The OAuth sign-in seam (BD-03), mirroring `SttProvider`/`StubSttProvider`
 * (@aizen/stt-worker) and `WebSearchProvider`/`NullWebSearchProvider`
 * (@aizen/research). `AuthProvider` is the vendor-neutral interface; the real
 * Google / Microsoft Entra adapters live in `provider-oauth.ts`, and
 * `StubAuthProvider` is the deterministic, network-free stand-in used when no
 * OAuth keys are present — so the app still boots and the account/quota features
 * are demoable without a real IdP (New_Feature.md §1).
 *
 * The flow is the standard Authorization-Code + PKCE handshake, expressed in two
 * steps so the server owns the redirect/cookie mechanics and the provider owns
 * only the IdP-specific bits:
 *
 *   1. `authorize({redirectUri})` → an `AuthRedirect`: the URL to send the browser
 *      to, plus the per-attempt `state` + PKCE `codeVerifier` the server stashes in
 *      a short-lived signed cookie.
 *   2. `exchange({code, codeVerifier, redirectUri})` → an `ExternalIdentity`: the
 *      provider's stable `subject` (`sub`) + email/name, after trading the auth
 *      code for tokens and reading the userinfo endpoint.
 *
 * The server maps `(provider, subject)` onto an `Account`/`Identity` — providers
 * never touch the database.
 */
import type { AuthProviderKind } from '@aizen/contracts';

/** What a provider hands back after a successful sign-in. */
export interface ExternalIdentity {
  provider: AuthProviderKind;
  /** The IdP's stable subject id (`sub`); unique within the provider. */
  subject: string;
  email: string | null;
  displayName: string | null;
}

/**
 * The result of step 1: where to send the browser, plus the secrets the server
 * must persist (in a signed, httpOnly cookie) to validate the callback.
 */
export interface AuthRedirect {
  url: string;
  /** CSRF token echoed back on the callback; the server checks it matches. */
  state: string;
  /** PKCE code-verifier; the server replays it into `exchange`. */
  codeVerifier: string;
}

export interface AuthorizeOptions {
  /** The absolute callback URL (`/auth/<provider>/callback`) the IdP returns to. */
  redirectUri: string;
}

export interface ExchangeOptions {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Vendor-neutral OAuth sign-in. Real adapters (Google/Entra) implement this. */
export interface AuthProvider {
  readonly kind: AuthProviderKind;
  authorize(opts: AuthorizeOptions): Promise<AuthRedirect>;
  exchange(opts: ExchangeOptions): Promise<ExternalIdentity>;
}

/**
 * Deterministic, network-free auth provider (BD-03, mirrors `StubProvider` /
 * `StubSttProvider`). Used when no OAuth keys are configured: clicking "sign in"
 * round-trips through our OWN callback with a fixed `code`, so the whole account
 * flow works locally with no IdP. Every call is reproducible — no RNG, no clock,
 * no network — so tests assert exact values.
 *
 * The single fake identity it returns is a stable local-dev account; pass a
 * `subject` to simulate distinct users (used by the cross-account tests).
 */
export class StubAuthProvider implements AuthProvider {
  readonly kind: AuthProviderKind = 'stub';
  private readonly subject: string;
  private readonly email: string;
  private readonly displayName: string;

  constructor(opts: { subject?: string; email?: string; displayName?: string } = {}) {
    this.subject = opts.subject ?? 'stub-user';
    this.email = opts.email ?? 'dev@localhost';
    this.displayName = opts.displayName ?? 'Local Dev';
  }

  async authorize(opts: AuthorizeOptions): Promise<AuthRedirect> {
    const state = `stub-state-${this.subject}`;
    // Point straight back at our own callback with a deterministic code. The
    // browser does a same-origin redirect; no external IdP is contacted.
    const url = `${opts.redirectUri}?code=stub-${encodeURIComponent(this.subject)}&state=${encodeURIComponent(state)}`;
    return { url, state, codeVerifier: `stub-verifier-${this.subject}` };
  }

  async exchange(opts: ExchangeOptions): Promise<ExternalIdentity> {
    // The subject is taken from the code we minted in `authorize` (so simulated
    // distinct users round-trip), falling back to this provider's own subject.
    const subject = opts.code.startsWith('stub-')
      ? decodeURIComponent(opts.code.slice('stub-'.length))
      : this.subject;
    return {
      provider: 'stub',
      subject,
      email: subject === this.subject ? this.email : `${subject}@localhost`,
      displayName: subject === this.subject ? this.displayName : subject,
    };
  }
}
