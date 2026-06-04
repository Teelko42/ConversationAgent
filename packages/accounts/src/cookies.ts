/**
 * Signed, httpOnly cookie sessions (New_Feature.md §1 — server-side session
 * cookies, not client-stored JWTs). A session cookie is a tamper-evident,
 * expiring envelope around a tiny payload (the account + identity ids): the value
 * is `base64url(JSON).hmacSHA256`, so a client can read nothing it should not and
 * cannot forge a value without the server secret (verified in constant time).
 *
 * Two cookies use this: the long-lived `aizen_session` (who you are) and the
 * short-lived `aizen_oauth` (the in-flight PKCE `state` + `codeVerifier`). Both
 * are set `HttpOnly; SameSite=Lax; Path=/` — and `Secure` in production.
 *
 * No external dependency: HMAC via `node:crypto`. `now()` is injectable so expiry
 * is deterministic in tests.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

function base64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function base64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

export interface CookieSignerOptions {
  secret: string;
  /** Injectable clock (ms epoch); defaults to `Date.now`. */
  now?: () => number;
}

export class CookieSigner {
  private readonly secret: string;
  private readonly now: () => number;

  constructor(opts: CookieSignerOptions) {
    if (!opts.secret) throw new Error('CookieSigner: a secret is required');
    this.secret = opts.secret;
    this.now = opts.now ?? Date.now;
  }

  private hmac(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }

  /** Sign `payload` into a cookie value that expires `ttlMs` from now. */
  sign(payload: Record<string, unknown>, ttlMs: number): string {
    const body = { ...payload, exp: this.now() + ttlMs };
    const encoded = base64urlEncode(JSON.stringify(body));
    return `${encoded}.${this.hmac(encoded)}`;
  }

  /** Verify + decode a cookie value. Returns null if tampered or expired. */
  verify<T = Record<string, unknown>>(token: string | undefined): (T & { exp: number }) | null {
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const encoded = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.hmac(encoded);
    // constant-time compare; mismatched lengths can't be equal.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let parsed: (T & { exp: number }) | null;
    try {
      parsed = JSON.parse(base64urlDecode(encoded)) as T & { exp: number };
    } catch {
      return null;
    }
    if (!parsed || typeof parsed.exp !== 'number' || parsed.exp < this.now()) return null;
    return parsed;
  }
}

/** Parse a `Cookie:` request header into a name→value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export interface SetCookieOptions {
  maxAgeSec?: number;
  /** Add `Secure` (HTTPS-only). Set true in production. */
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  httpOnly?: boolean;
}

/** Build a `Set-Cookie` header value. Defaults: HttpOnly, SameSite=Lax, Path=/. */
export function serializeCookie(name: string, value: string, opts: SetCookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeSec)}`);
  return parts.join('; ');
}

/** Build a `Set-Cookie` that immediately clears `name`. */
export function clearCookie(name: string, opts: SetCookieOptions = {}): string {
  return serializeCookie(name, '', { ...opts, maxAgeSec: 0 });
}
