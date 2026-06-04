import { describe, it, expect } from 'vitest';
import { StubAuthProvider } from './auth-provider.js';
import { OAuthProvider, GOOGLE_ENDPOINTS, microsoftEndpoints } from './provider-oauth.js';
import { makeAuthProviders } from './make-auth.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('StubAuthProvider (no-key demo seam, deterministic)', () => {
  it('round-trips through our own callback with a fixed code + no network', async () => {
    const p = new StubAuthProvider();
    const redir = await p.authorize({ redirectUri: 'http://localhost:5173/auth/stub/callback' });
    expect(redir.url).toContain('http://localhost:5173/auth/stub/callback');
    expect(redir.url).toContain('code=stub-stub-user');
    expect(redir.state).toBe('stub-state-stub-user');

    const ext = await p.exchange({ code: 'stub-stub-user', codeVerifier: redir.codeVerifier, redirectUri: 'x' });
    expect(ext).toEqual({ provider: 'stub', subject: 'stub-user', email: 'dev@localhost', displayName: 'Local Dev' });
  });

  it('simulates distinct users via the code (used by cross-account tests)', async () => {
    const p = new StubAuthProvider();
    const ext = await p.exchange({ code: 'stub-alice', codeVerifier: 'x', redirectUri: 'x' });
    expect(ext.subject).toBe('alice');
    expect(ext.email).toBe('alice@localhost');
  });
});

/** A fake fetch that serves a token then a userinfo response, capturing requests. */
function fakeFetch(capture: { calls: Array<{ url: string; init?: any }> }) {
  return (async (url: string, init?: any) => {
    capture.calls.push({ url: String(url), init });
    if (String(url).includes('token')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ access_token: 'at_123', token_type: 'Bearer', id_token: 'idt' }),
      };
    }
    // userinfo
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ sub: 'g-sub-1', email: 'user@example.com', name: 'Real User' }),
    };
  }) as unknown as typeof fetch;
}

describe('OAuthProvider (real Google/Entra swap-in, injected fetch)', () => {
  it('builds an Authorization-Code + PKCE redirect (S256 challenge, state)', async () => {
    // Deterministic entropy → deterministic verifier/state/challenge.
    const rb = (n: number) => Buffer.alloc(n, 7);
    const p = new OAuthProvider({
      kind: 'google',
      clientId: 'cid',
      clientSecret: 'secret',
      endpoints: GOOGLE_ENDPOINTS,
      randomBytesImpl: rb,
    });
    const redir = await p.authorize({ redirectUri: 'http://localhost:5173/auth/google/callback' });
    const u = new URL(redir.url);
    expect(u.origin + u.pathname).toBe(GOOGLE_ENDPOINTS.authUrl);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    // PKCE: the challenge is the base64url SHA-256 of the verifier (never the verifier).
    expect(u.searchParams.get('code_challenge')).not.toBe(redir.codeVerifier);
    expect(u.searchParams.get('state')).toBe(redir.state);
  });

  it('exchanges the code for tokens then reads userinfo → ExternalIdentity', async () => {
    const cap = { calls: [] as Array<{ url: string; init?: any }> };
    const p = new OAuthProvider({
      kind: 'google',
      clientId: 'cid',
      clientSecret: 'secret',
      endpoints: GOOGLE_ENDPOINTS,
      fetchImpl: fakeFetch(cap),
    });
    const ext = await p.exchange({ code: 'auth-code', codeVerifier: 'verifier', redirectUri: 'http://cb' });
    expect(ext).toEqual({ provider: 'google', subject: 'g-sub-1', email: 'user@example.com', displayName: 'Real User' });

    // The token POST carried the PKCE verifier + the auth code (form-encoded).
    const tokenCall = cap.calls.find((c) => c.url.includes('token'))!;
    expect(tokenCall.init.method).toBe('POST');
    expect(String(tokenCall.init.body)).toContain('code_verifier=verifier');
    expect(String(tokenCall.init.body)).toContain('grant_type=authorization_code');
    // The userinfo GET carried the bearer token.
    const infoCall = cap.calls.find((c) => c.url.includes('userinfo'))!;
    expect(infoCall.init.headers.authorization).toBe('Bearer at_123');
  });

  it('throws a clear error when the token endpoint returns an error', async () => {
    const errFetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }),
    })) as unknown as typeof fetch;
    const p = new OAuthProvider({
      kind: 'microsoft',
      clientId: 'cid',
      clientSecret: 'secret',
      endpoints: microsoftEndpoints(),
      fetchImpl: errFetch,
    });
    await expect(p.exchange({ code: 'x', codeVerifier: 'v', redirectUri: 'cb' })).rejects.toThrow(/invalid_grant/);
  });

  it('requires a client id + secret', () => {
    expect(() => new OAuthProvider({ kind: 'google', clientId: '', clientSecret: '', endpoints: GOOGLE_ENDPOINTS })).toThrow();
  });
});

describe('makeAuthProviders (BD-03 key-gating)', () => {
  it('offers only the stub when no OAuth keys are present', () => {
    const seam = makeAuthProviders({});
    expect(seam.mode).toBe('stub');
    expect(seam.enabled).toEqual(['stub']);
    expect(seam.get('stub')).toBeDefined();
    expect(seam.get('google')).toBeUndefined();
  });

  it('enables the real providers when keys are present (stub still resolvable)', () => {
    const seam = makeAuthProviders({
      google: { clientId: 'g', clientSecret: 'gs' },
      microsoft: { clientId: 'm', clientSecret: 'ms' },
    });
    expect(seam.mode).toBe('real');
    expect(seam.enabled.sort()).toEqual(['google', 'microsoft']);
    expect(seam.get('google')).toBeDefined();
    expect(seam.get('microsoft')).toBeDefined();
    // the stub is still resolvable (never offered for sign-in in real mode).
    expect(seam.get('stub')).toBeDefined();
  });
});
