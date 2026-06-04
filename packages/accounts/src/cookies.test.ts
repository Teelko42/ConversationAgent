import { describe, it, expect } from 'vitest';
import { CookieSigner, parseCookies, serializeCookie, clearCookie } from './cookies.js';

describe('CookieSigner (signed, expiring session cookies)', () => {
  it('signs then verifies a payload round-trip', () => {
    const signer = new CookieSigner({ secret: 'top-secret', now: () => 1000 });
    const token = signer.sign({ accountId: 'acc-1', identityId: 'id-1' }, 60_000);
    const got = signer.verify<{ accountId: string; identityId: string }>(token);
    expect(got?.accountId).toBe('acc-1');
    expect(got?.identityId).toBe('id-1');
    expect(got?.exp).toBe(61_000);
  });

  it('rejects a tampered value', () => {
    const signer = new CookieSigner({ secret: 's', now: () => 0 });
    const token = signer.sign({ accountId: 'acc-1' }, 60_000);
    const tampered = token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    expect(signer.verify(tampered)).toBeNull();
  });

  it('rejects a value signed with a different secret (forgery)', () => {
    const a = new CookieSigner({ secret: 'secret-a', now: () => 0 });
    const b = new CookieSigner({ secret: 'secret-b', now: () => 0 });
    expect(b.verify(a.sign({ x: 1 }, 60_000))).toBeNull();
  });

  it('rejects an expired value', () => {
    let t = 0;
    const signer = new CookieSigner({ secret: 's', now: () => t });
    const token = signer.sign({ accountId: 'acc-1' }, 1_000);
    t = 2_000; // advance past exp
    expect(signer.verify(token)).toBeNull();
  });

  it('returns null for undefined / malformed tokens', () => {
    const signer = new CookieSigner({ secret: 's', now: () => 0 });
    expect(signer.verify(undefined)).toBeNull();
    expect(signer.verify('no-dot')).toBeNull();
    expect(signer.verify('.sigonly')).toBeNull();
  });

  it('requires a secret', () => {
    expect(() => new CookieSigner({ secret: '' })).toThrow();
  });
});

describe('cookie header helpers', () => {
  it('parses a Cookie header into name→value', () => {
    const got = parseCookies('aizen_session=abc.def; aizen_theme=dark; x=%2Fpath');
    expect(got.aizen_session).toBe('abc.def');
    expect(got.aizen_theme).toBe('dark');
    expect(got.x).toBe('/path'); // url-decoded
  });

  it('returns {} for a missing header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('serializes a Set-Cookie with HttpOnly + SameSite=Lax by default', () => {
    const c = serializeCookie('aizen_session', 'v', { maxAgeSec: 3600 });
    expect(c).toContain('aizen_session=v');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=3600');
  });

  it('adds Secure when requested and clears with Max-Age=0', () => {
    expect(serializeCookie('s', 'v', { secure: true })).toContain('Secure');
    expect(clearCookie('s')).toContain('Max-Age=0');
  });
});
