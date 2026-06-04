import { describe, it, expect } from 'vitest';
import {
  AccountService,
  CookieSigner,
  InMemoryAccountRepository,
  makeAuthProviders,
} from '@aizen/accounts';
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

function makeSys(): AccountSystem {
  let n = 0;
  const genId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const repo = new InMemoryAccountRepository();
  const service = new AccountService({ repo, genId, nowMs: () => 1_700_000_000_000 });
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
