import { describe, it, expect } from 'vitest';
import {
  AccountService,
  CookieSigner,
  DEFAULT_ENTITLEMENTS,
  InMemoryAccountRepository,
  makeAuthProviders,
} from '@aizen/accounts';
import type { Entitlement, Tier } from '@aizen/contracts';
import { handleAccountRequest, type AccountSystem } from '../src/accounts.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Route tests for the saved-session read endpoint (New_Feature.md F1 §7):
 *   GET /api/sessions/:id → 200 {session, artifacts} for the owner, 404 for a
 *   missing / other-account id (the repo is account-scoped, so isolation is
 *   structural), 401 when signed out.
 *
 * The handler takes raw node:http req/res; we build minimal mocks. For GET there
 * is no request body to read, so an `on()`-less req is fine.
 */
const SESSION_COOKIE = 'aizen_session';

function makeSys(opts: { sourceCapBytes?: number } = {}): AccountSystem {
  let n = 0;
  const genId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const repo = new InMemoryAccountRepository();
  // Optional tiny stored-source cap, to exercise the 409 path cheaply.
  const entitlements =
    opts.sourceCapBytes === undefined
      ? undefined
      : ({
          ...DEFAULT_ENTITLEMENTS,
          free: { ...DEFAULT_ENTITLEMENTS.free, max_source_bytes: opts.sourceCapBytes },
        } as Record<Tier, Entitlement>);
  const service = new AccountService({
    repo,
    genId,
    nowMs: () => 1_700_000_000_000,
    ...(entitlements ? { entitlements } : {}),
  });
  const cookies = new CookieSigner({ secret: 'test-secret' });
  const auth = makeAuthProviders({}); // no OAuth keys → stub provider only
  return {
    service,
    auth,
    cookies,
    authMode: auth.mode,
    dbBackend: 'memory',
    providerStatus: { stt: 'stub', llm: 'stub', search: 'off', auth: 'stub' },
  };
}

function mockReq(opts: { method: string; url: string; cookie?: string }): any {
  return {
    method: opts.method,
    url: opts.url,
    headers: { host: 'localhost', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    socket: {},
  };
}

/** Like mockReq but delivers a JSON body (drives `readJsonBody`'s data/end events). */
function mockReqBody(opts: { method: string; url: string; cookie?: string; body?: unknown }): any {
  const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
  return {
    method: opts.method,
    url: opts.url,
    headers: { host: 'localhost', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    socket: {},
    on(event: string, cb: (arg?: any) => void) {
      if (event === 'data' && payload) cb(Buffer.from(payload, 'utf8'));
      else if (event === 'end') cb();
      return this;
    },
    destroy() {},
  };
}

function mockRes(): any {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      res.statusCode = status;
      if (headers) res.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk != null) res.body = String(chunk);
    },
  };
  return res;
}

/** A signed session cookie header for an account. */
function cookieFor(sys: AccountSystem, accountId: string, identityId: string): string {
  return `${SESSION_COOKIE}=${sys.cookies.sign({ accountId, identityId }, 60_000)}`;
}

async function seedOwnerWithSession() {
  const sys = makeSys();
  const { account, identity } = await sys.service.upsertIdentity({
    provider: 'stub',
    subject: 'owner-1',
    email: 'owner@example.com',
    displayName: 'Owner',
  });
  const saved = await sys.service.saveResource(account.id, {
    sessionId: '5f5f5f5f-0000-4000-8000-000000000001',
    title: 'My saved session',
    consentClass: 'standard',
    piiPresent: false,
    artifacts: [
      { kind: 'transcript_segment', payload: { who: 'Alice', text: 'hello world' } },
      { kind: 'transcript_segment', payload: { who: 'Bob', text: 'second line' } },
    ],
  });
  return { sys, account, identity, saved };
}

describe('GET /api/sessions/:id', () => {
  it('returns 200 with the session + its artifacts for the owner', async () => {
    const { sys, account, identity, saved } = await seedOwnerWithSession();
    const res = mockRes();
    const handled = await handleAccountRequest(
      mockReq({ method: 'GET', url: `/api/sessions/${saved.id}`, cookie: cookieFor(sys, account.id, identity.id) }),
      res,
      sys,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.session.id).toBe(saved.id);
    expect(body.session.title).toBe('My saved session');
    expect(body.artifacts).toHaveLength(2);
    expect(body.artifacts[0].kind).toBe('transcript_segment');
    expect(body.artifacts[0].payload).toMatchObject({ who: 'Alice', text: 'hello world' });
  });

  it('returns 404 for an id that does not exist', async () => {
    const { sys, account, identity } = await seedOwnerWithSession();
    const res = mockRes();
    await handleAccountRequest(
      mockReq({
        method: 'GET',
        url: '/api/sessions/5f5f5f5f-0000-4000-8000-0000000000ff',
        cookie: cookieFor(sys, account.id, identity.id),
      }),
      res,
      sys,
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'not_found' });
  });

  it('returns 404 for another account’s session id (account-scoped isolation)', async () => {
    const { sys, saved } = await seedOwnerWithSession();
    const other = await sys.service.upsertIdentity({
      provider: 'stub',
      subject: 'intruder-1',
      email: 'intruder@example.com',
      displayName: 'Intruder',
    });
    const res = mockRes();
    await handleAccountRequest(
      mockReq({
        method: 'GET',
        url: `/api/sessions/${saved.id}`,
        cookie: cookieFor(sys, other.account.id, other.identity.id),
      }),
      res,
      sys,
    );
    expect(res.statusCode).toBe(404); // cannot read someone else's resource
  });

  it('returns 401 when signed out (no session cookie)', async () => {
    const { sys, saved } = await seedOwnerWithSession();
    const res = mockRes();
    await handleAccountRequest(mockReq({ method: 'GET', url: `/api/sessions/${saved.id}` }), res, sys);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'not_authenticated' });
  });
});

describe('/api/sources — stored-source CRUD (F3 Phase B §7)', () => {
  async function seedOwner(sys: AccountSystem) {
    const { account, identity } = await sys.service.upsertIdentity({
      provider: 'stub',
      subject: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
    });
    return { account, identity, cookie: cookieFor(sys, account.id, identity.id) };
  }

  it('POST saves a source (201, metadata only — no text) then GET lists it + quota', async () => {
    const sys = makeSys();
    const { cookie } = await seedOwner(sys);

    const postRes = mockRes();
    await handleAccountRequest(
      mockReqBody({ method: 'POST', url: '/api/sources', cookie, body: { title: 'brief.md', origin: 'file', text: 'hello world' } }),
      postRes,
      sys,
    );
    expect(postRes.statusCode).toBe(201);
    const posted = JSON.parse(postRes.body);
    expect(posted.saved).toMatchObject({ title: 'brief.md', origin: 'file', bytes: 11 });
    expect('text' in posted.saved).toBe(false); // metadata only
    expect(posted.quota).toMatchObject({ used_bytes: 11, count: 1 });

    const listRes = mockRes();
    await handleAccountRequest(mockReq({ method: 'GET', url: '/api/sources', cookie }), listRes, sys);
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.sources).toHaveLength(1);
    expect('text' in list.sources[0]).toBe(false);
    expect(list.quota.used_bytes).toBe(11);
  });

  it('GET /api/sources/:id returns the full source incl. text (to reload the library)', async () => {
    const sys = makeSys();
    const { account, cookie } = await seedOwner(sys);
    const saved = await sys.service.saveSource(account.id, {
      title: 'note.md',
      origin: 'obsidian',
      text: 'The mascot is a blue otter.',
      consentClass: 'standard',
      piiPresent: false,
    });
    const res = mockRes();
    await handleAccountRequest(mockReq({ method: 'GET', url: `/api/sources/${saved.id}`, cookie }), res, sys);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).source).toMatchObject({ origin: 'obsidian', text: 'The mascot is a blue otter.' });
  });

  it('DELETE frees byte quota; a second delete is 404', async () => {
    const sys = makeSys();
    const { account, cookie } = await seedOwner(sys);
    const saved = await sys.service.saveSource(account.id, { title: 'x', origin: 'file', text: 'some text', consentClass: 'standard', piiPresent: false });

    const del = mockRes();
    await handleAccountRequest(mockReq({ method: 'DELETE', url: `/api/sources/${saved.id}`, cookie }), del, sys);
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body).quota.used_bytes).toBe(0);

    const del2 = mockRes();
    await handleAccountRequest(mockReq({ method: 'DELETE', url: `/api/sources/${saved.id}`, cookie }), del2, sys);
    expect(del2.statusCode).toBe(404);
  });

  it('over the byte cap → 409 with the typed QuotaError body', async () => {
    const sys = makeSys({ sourceCapBytes: 10 });
    const { cookie } = await seedOwner(sys);
    const res = mockRes();
    await handleAccountRequest(
      mockReqBody({ method: 'POST', url: '/api/sources', cookie, body: { title: 'big', origin: 'file', text: 'way over the ten byte cap' } }),
      res,
      sys,
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'quota_exceeded', tier: 'free', limit: 10 });
  });

  it('is account-scoped: another account cannot read someone else’s source (404)', async () => {
    const sys = makeSys();
    const owner = await seedOwner(sys);
    const saved = await sys.service.saveSource(owner.account.id, { title: 'A only', origin: 'file', text: 'secret', consentClass: 'standard', piiPresent: false });
    const intruder = await sys.service.upsertIdentity({ provider: 'stub', subject: 'intruder', email: 'i@x', displayName: 'I' });
    const res = mockRes();
    await handleAccountRequest(
      mockReq({ method: 'GET', url: `/api/sources/${saved.id}`, cookie: cookieFor(sys, intruder.account.id, intruder.identity.id) }),
      res,
      sys,
    );
    expect(res.statusCode).toBe(404);
  });

  it('rejects an empty-text POST (400) and an anonymous request (401)', async () => {
    const sys = makeSys();
    const { cookie } = await seedOwner(sys);
    const bad = mockRes();
    await handleAccountRequest(mockReqBody({ method: 'POST', url: '/api/sources', cookie, body: { title: 'x', origin: 'file', text: '   ' } }), bad, sys);
    expect(bad.statusCode).toBe(400);

    const anon = mockRes();
    await handleAccountRequest(mockReq({ method: 'GET', url: '/api/sources' }), anon, sys);
    expect(anon.statusCode).toBe(401);
  });
});
