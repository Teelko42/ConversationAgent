/**
 * Server-side account integration (New_Feature.md). Builds the account system at
 * startup and handles all of its HTTP routes, layered AROUND the existing
 * mic→STT→intel WebSocket pipeline without changing it:
 *
 *   GET  /api/session            — who am I + my tier + quota + the sign-in menu
 *   GET  /auth/:provider/login   — start the OAuth (or stub) sign-in (PKCE)
 *   GET  /auth/:provider/callback— finish sign-in, set the session cookie
 *   POST /auth/logout            — clear the session cookie
 *   GET  /api/sessions           — list MY saved sessions (account-scoped)
 *   POST /api/sessions           — save the current session as a resource (quota-checked)
 *   GET  /api/sessions/:id        — read one of MY saved sessions + its artifacts
 *   DELETE /api/sessions/:id      — delete one of MY saved sessions (frees quota)
 *
 * Everything is key-gated (BD-03): with no OAuth keys the only sign-in offered is
 * the deterministic Stub provider, and a user who never signs in keeps the
 * unchanged anonymous/demo flow. Sessions are signed, httpOnly cookies.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AccountService,
  CookieSigner,
  InMemoryAccountRepository,
  PgAccountRepository,
  QuotaExceededError,
  SourceQuotaExceededError,
  clearCookie,
  makeAuthProviders,
  openAccountDb,
  parseCookies,
  serializeCookie,
  type AccountRepository,
  type ArtifactInput,
  type AuthSeam,
} from '@aizen/accounts';
import type { Entitlement, StoredArtifact, StoredSource, Tier } from '@aizen/contracts';
import { providerStatus, type AppConfig, type ProviderStatus } from './config.js';

const SESSION_COOKIE = 'aizen_session';
const OAUTH_COOKIE = 'aizen_oauth';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes (the sign-in round-trip)
const MAX_BODY_BYTES = 1_000_000; // cap a save payload (artifacts) at ~1 MB
// A stored-source POST carries the EXTRACTED TEXT of a file/note, which can be
// larger than a session save; allow more headroom (the tier byte quota is the real
// ceiling — F3 §7 "bump MAX_BODY_BYTES for this route").
const MAX_SOURCE_BODY_BYTES = 6_000_000; // ~6 MB
const MAX_STORED_SOURCE_TEXT = 4_000_000; // hard cap on one source's stored text
const MAX_STORED_SOURCE_TITLE = 512;

/** The artifact families a client may persist (mirrors `StoredArtifact.kind`). */
const ARTIFACT_KINDS: ReadonlySet<StoredArtifact['kind']> = new Set([
  'transcript_segment',
  'concept_card',
  'kg_node',
  'kg_edge',
  'insight_item',
]);

/** The provenance families a stored source may carry (mirrors `StoredSource.origin`). */
const SOURCE_ORIGINS: ReadonlySet<StoredSource['origin']> = new Set(['file', 'paste', 'obsidian']);

/** The four packaging tiers, in display order (team-10 §1.2). */
const TIERS: readonly Tier[] = ['free', 'pro', 'team', 'enterprise'];

export interface AccountSystem {
  service: AccountService;
  auth: AuthSeam;
  cookies: CookieSigner;
  /** Which auth backend is live, for the startup banner. */
  authMode: 'real' | 'stub';
  /** Which persistence backend the repository actually uses. */
  dbBackend: 'postgres' | 'sqlite' | 'memory';
  /** Which real STT/LLM/search/auth providers are active (for the Providers UI). */
  providerStatus: ProviderStatus;
}

/** TLS for Azure PostgreSQL: a `sslmode=require` URL turns transit encryption on. */
function pgSslFor(databaseUrl: string): { rejectUnauthorized: boolean } | undefined {
  return /[?&]sslmode=(require|verify-ca|verify-full)/i.test(databaseUrl)
    ? { rejectUnauthorized: false } // simplest; supply the Azure CA for full verification
    : undefined;
}

/**
 * Build the account system. The repository is **PostgreSQL** when `DATABASE_URL`
 * is set and reachable (the Azure Phase-1+ store), else **SQLite** (a single file)
 * when `node:sqlite` is available, else the in-memory store — so the app always
 * boots (fail-open, BD-03). The cookie secret falls back to an ephemeral
 * per-process one when unset (logins then survive reloads but not a restart — set
 * SESSION_COOKIE_SECRET, ideally from Key Vault, to persist them and to share one
 * secret across replicas).
 */
export async function buildAccountSystem(cfg: AppConfig): Promise<AccountSystem> {
  let repo: AccountRepository | undefined;
  let dbBackend: 'postgres' | 'sqlite' | 'memory' = 'memory';

  // 1) PostgreSQL (preferred when configured).
  if (cfg.databaseUrl) {
    try {
      const ssl = pgSslFor(cfg.databaseUrl);
      repo = await PgAccountRepository.open({
        connectionString: cfg.databaseUrl,
        ...(ssl ? { ssl } : {}),
      });
      dbBackend = 'postgres';
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[accounts] DATABASE_URL set but Postgres is unreachable; falling back:', err);
    }
  }

  // 2) SQLite file (Phase-0 default), then 3) in-memory.
  if (!repo) {
    if (cfg.accountsDbPath && cfg.accountsDbPath !== ':memory:') {
      try {
        mkdirSync(dirname(cfg.accountsDbPath), { recursive: true });
      } catch {
        /* dir may already exist */
      }
    }
    const opened = openAccountDb(cfg.accountsDbPath);
    if (opened.repo) {
      repo = opened.repo;
      dbBackend = 'sqlite';
    } else {
      repo = new InMemoryAccountRepository();
      dbBackend = 'memory';
    }
  }

  const service = new AccountService({ repo });
  const auth = makeAuthProviders({
    google:
      cfg.googleClientId && cfg.googleClientSecret
        ? { clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret }
        : undefined,
    microsoft:
      cfg.microsoftClientId && cfg.microsoftClientSecret
        ? {
            clientId: cfg.microsoftClientId,
            clientSecret: cfg.microsoftClientSecret,
            tenant: cfg.microsoftTenant,
          }
        : undefined,
  });
  const secret = cfg.sessionCookieSecret ?? randomBytes(32).toString('hex');
  const cookies = new CookieSigner({ secret });

  return { service, auth, cookies, authMode: auth.mode, dbBackend, providerStatus: providerStatus(cfg) };
}

/** The per-tier plan/quota table the Providers popup renders (sourced, not hard-coded). */
function planTable(sys: AccountSystem): Entitlement[] {
  return TIERS.map((t) => sys.service.entitlement(t));
}

// --- tiny http helpers ------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: string[] = []): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders.length ? { 'set-cookie': extraHeaders } : {}),
  });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string, setCookies: string[] = []): void {
  res.writeHead(302, { location, ...(setCookies.length ? { 'set-cookie': setCookies } : {}) });
  res.end();
}

/** The app's external origin for building OAuth redirect URIs + a `Secure` flag. */
function origin(req: IncomingMessage): { base: string; secure: boolean } {
  const xfproto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  const proto = xfproto || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = req.headers.host ?? 'localhost';
  return { base: `${proto}://${host}`, secure: proto === 'https' };
}

/** Read a JSON request body, bounded by `maxBytes` (default `MAX_BODY_BYTES`). */
function readJsonBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** The signed-in account id from the session cookie, or null. */
function currentAccountId(req: IncomingMessage, sys: AccountSystem): string | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = sys.cookies.verify<{ accountId: string; identityId: string }>(token);
  return session?.accountId ?? null;
}

/** Coerce a client-supplied artifact list into validated `ArtifactInput`s. */
function coerceArtifacts(input: unknown): ArtifactInput[] {
  if (!Array.isArray(input)) return [];
  const out: ArtifactInput[] = [];
  for (const a of input) {
    if (!a || typeof a !== 'object') continue;
    const kind = (a as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !ARTIFACT_KINDS.has(kind as StoredArtifact['kind'])) continue;
    const id = (a as { id?: unknown }).id;
    out.push({
      kind: kind as StoredArtifact['kind'],
      payload: (a as { payload?: unknown }).payload ?? null,
      ...(typeof id === 'string' ? { id } : {}),
    });
    if (out.length >= 2000) break; // bound how many artifacts one save can carry
  }
  return out;
}

/** A stored source WITHOUT its `text` — the list/metadata shape (F3 §7). */
function sourceMeta(s: StoredSource): Omit<StoredSource, 'text'> {
  const { text: _text, ...meta } = s;
  void _text;
  return meta;
}

/**
 * Handle an account-related HTTP request. Returns true if it owned the request
 * (so the caller stops); false to fall through to static assets / 404.
 */
export async function handleAccountRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sys: AccountSystem,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // --- GET /api/session — current identity + tier + quota + sign-in menu ---
  // Also carries `provider_status` (active STT/LLM/search/auth providers) and the
  // per-tier `plans` table, so the Providers popup renders real, sourced data even
  // when the user is signed out.
  if (method === 'GET' && path === '/api/session') {
    const accountId = currentAccountId(req, sys);
    const base = {
      providers: sys.auth.enabled,
      authMode: sys.auth.mode,
      provider_status: sys.providerStatus,
      plans: planTable(sys),
    };
    if (!accountId) {
      sendJson(res, 200, { authenticated: false, ...base });
      return true;
    }
    const account = await sys.service.getAccount(accountId);
    if (!account) {
      // stale cookie (account gone) → clear it + report anonymous.
      sendJson(res, 200, { authenticated: false, ...base }, [
        clearCookie(SESSION_COOKIE, { secure: origin(req).secure }),
      ]);
      return true;
    }
    const identities = await sys.service.getIdentitiesForAccount(accountId);
    const identity = identities[0] ?? null;
    sendJson(res, 200, {
      authenticated: true,
      account: { id: account.id, tier: account.tier, display_name: account.display_name },
      identity: identity
        ? { provider: identity.provider, email: identity.email, display_name: identity.display_name }
        : null,
      quota: await sys.service.quotaStatus(accountId),
      ...base,
    });
    return true;
  }

  // --- GET /auth/:provider/login — begin sign-in (Authorization-Code + PKCE) ---
  const loginMatch = /^\/auth\/([a-z]+)\/login$/.exec(path);
  if (method === 'GET' && loginMatch) {
    const providerName = loginMatch[1]!;
    const provider = sys.auth.get(providerName);
    if (!provider || !sys.auth.enabled.includes(provider.kind)) {
      sendJson(res, 404, { error: 'unknown_provider', provider: providerName });
      return true;
    }
    const { base, secure } = origin(req);
    const redirectUri = `${base}/auth/${providerName}/callback`;
    try {
      const { url: authUrl, state, codeVerifier } = await provider.authorize({ redirectUri });
      const stash = sys.cookies.sign({ state, codeVerifier, provider: providerName }, OAUTH_TTL_MS);
      redirect(res, authUrl, [
        serializeCookie(OAUTH_COOKIE, stash, { maxAgeSec: OAUTH_TTL_MS / 1000, secure, sameSite: 'Lax' }),
      ]);
    } catch (err) {
      sendJson(res, 500, { error: 'authorize_failed', message: String((err as Error)?.message ?? err) });
    }
    return true;
  }

  // --- GET /auth/:provider/callback — finish sign-in, set the session cookie ---
  const cbMatch = /^\/auth\/([a-z]+)\/callback$/.exec(path);
  if (method === 'GET' && cbMatch) {
    const providerName = cbMatch[1]!;
    const provider = sys.auth.get(providerName);
    const { base, secure } = origin(req);
    const code = url.searchParams.get('code') ?? '';
    const stateParam = url.searchParams.get('state') ?? '';
    const stash = sys.cookies.verify<{ state: string; codeVerifier: string; provider: string }>(
      parseCookies(req.headers.cookie)[OAUTH_COOKIE],
    );

    // Validate the round-trip: known provider, matching CSRF state, present code.
    if (!provider || !stash || stash.provider !== providerName || stash.state !== stateParam || !code) {
      redirect(res, '/?auth_error=invalid_state', [clearCookie(OAUTH_COOKIE, { secure })]);
      return true;
    }
    try {
      const redirectUri = `${base}/auth/${providerName}/callback`;
      const ext = await provider.exchange({ code, codeVerifier: stash.codeVerifier, redirectUri });
      const { account, identity } = await sys.service.upsertIdentity(ext);
      const session = sys.cookies.sign({ accountId: account.id, identityId: identity.id }, SESSION_TTL_MS);
      redirect(res, '/', [
        serializeCookie(SESSION_COOKIE, session, { maxAgeSec: SESSION_TTL_MS / 1000, secure, sameSite: 'Lax' }),
        clearCookie(OAUTH_COOKIE, { secure }),
      ]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[accounts] sign-in failed:', err);
      redirect(res, '/?auth_error=exchange_failed', [clearCookie(OAUTH_COOKIE, { secure })]);
    }
    return true;
  }

  // --- POST /auth/logout — clear the session cookie ---
  if (method === 'POST' && path === '/auth/logout') {
    sendJson(res, 200, { ok: true }, [clearCookie(SESSION_COOKIE, { secure: origin(req).secure })]);
    return true;
  }

  // --- /api/sessions — saved-resource CRUD (all account-scoped) ---
  if (path === '/api/sessions') {
    const accountId = currentAccountId(req, sys);
    if (!accountId || !(await sys.service.getAccount(accountId))) {
      sendJson(res, 401, { error: 'not_authenticated' });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, {
        sessions: await sys.service.listResources(accountId),
        quota: await sys.service.quotaStatus(accountId),
      });
      return true;
    }
    if (method === 'POST') {
      let body: { session_id?: unknown; title?: unknown; artifacts?: unknown; consent_class?: unknown };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch (err) {
        sendJson(res, 400, { error: 'bad_request', message: String((err as Error)?.message ?? err) });
        return true;
      }
      const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
        sendJson(res, 400, { error: 'bad_request', message: 'session_id must be a session uuid' });
        return true;
      }
      // Consent is server-determined and fail-closed: the live pipeline runs the
      // default standard/non-PII consent context, and the client may only UPGRADE
      // a save to 'sensitive' (never downgrade) — accounts never relax team-09.
      const sensitive = body.consent_class === 'sensitive';
      try {
        const saved = await sys.service.saveResource(accountId, {
          sessionId,
          title: typeof body.title === 'string' ? body.title : 'Untitled session',
          consentClass: sensitive ? 'sensitive' : 'standard',
          piiPresent: sensitive,
          artifacts: coerceArtifacts(body.artifacts),
        });
        sendJson(res, 201, { saved, quota: await sys.service.quotaStatus(accountId) });
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          sendJson(res, 409, err.body);
        } else {
          sendJson(res, 500, { error: 'save_failed', message: String((err as Error)?.message ?? err) });
        }
      }
      return true;
    }
  }

  // --- /api/sessions/:id — read (GET) or delete (DELETE) one of MY saved sessions ---
  // The repo is account-scoped, so `getResource`/`listArtifacts`/`deleteResource`
  // already return null/[]/false for another account's id — a 404 falls out
  // naturally with no extra ownership check (team-09 T6).
  const idMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (idMatch && (method === 'GET' || method === 'DELETE')) {
    const accountId = currentAccountId(req, sys);
    if (!accountId || !(await sys.service.getAccount(accountId))) {
      sendJson(res, 401, { error: 'not_authenticated' });
      return true;
    }
    const id = decodeURIComponent(idMatch[1]!);

    if (method === 'GET') {
      const session = await sys.service.getResource(accountId, id);
      if (!session) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      sendJson(res, 200, {
        session,
        artifacts: await sys.service.listArtifacts(accountId, id),
      });
      return true;
    }

    // DELETE
    const removed = await sys.service.deleteResource(accountId, id);
    if (!removed) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    sendJson(res, 200, { ok: true, quota: await sys.service.quotaStatus(accountId) });
    return true;
  }

  // --- /api/sources — stored-source CRUD (F3 Phase B, all account-scoped) ---
  if (path === '/api/sources') {
    const accountId = currentAccountId(req, sys);
    if (!accountId || !(await sys.service.getAccount(accountId))) {
      sendJson(res, 401, { error: 'not_authenticated' });
      return true;
    }
    if (method === 'GET') {
      // Metadata only — the list never ships the stored text (F3 §7).
      const sources = (await sys.service.listSources(accountId)).map(sourceMeta);
      sendJson(res, 200, { sources, quota: await sys.service.sourceQuotaStatus(accountId) });
      return true;
    }
    if (method === 'POST') {
      let body: {
        id?: unknown;
        title?: unknown;
        origin?: unknown;
        mime?: unknown;
        text?: unknown;
        consent_class?: unknown;
      };
      try {
        body = (await readJsonBody(req, MAX_SOURCE_BODY_BYTES)) as typeof body;
      } catch (err) {
        sendJson(res, 400, { error: 'bad_request', message: String((err as Error)?.message ?? err) });
        return true;
      }
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) {
        sendJson(res, 400, { error: 'bad_request', message: 'text is required' });
        return true;
      }
      const origin = SOURCE_ORIGINS.has(body.origin as StoredSource['origin'])
        ? (body.origin as StoredSource['origin'])
        : 'file';
      // Consent is server-determined + fail-closed (same posture as saveResource):
      // the client may only UPGRADE a save to 'sensitive', never downgrade.
      const sensitive = body.consent_class === 'sensitive';
      try {
        const saved = await sys.service.saveSource(accountId, {
          ...(typeof body.id === 'string' && body.id ? { id: body.id } : {}),
          title:
            typeof body.title === 'string' && body.title
              ? body.title.slice(0, MAX_STORED_SOURCE_TITLE)
              : 'Untitled source',
          origin,
          ...(typeof body.mime === 'string' && body.mime ? { mime: body.mime.slice(0, 200) } : {}),
          text: text.slice(0, MAX_STORED_SOURCE_TEXT),
          consentClass: sensitive ? 'sensitive' : 'standard',
          piiPresent: sensitive,
        });
        sendJson(res, 201, {
          saved: sourceMeta(saved),
          quota: await sys.service.sourceQuotaStatus(accountId),
        });
      } catch (err) {
        if (err instanceof SourceQuotaExceededError) {
          sendJson(res, 409, err.body);
        } else {
          sendJson(res, 500, { error: 'save_failed', message: String((err as Error)?.message ?? err) });
        }
      }
      return true;
    }
  }

  // --- /api/sources/:id — read (incl. text) or delete one of MY sources ---
  // The repo is account-scoped, so get/delete already return null/false for another
  // account's id — a 404 falls out naturally (team-09 T6).
  const srcIdMatch = /^\/api\/sources\/([^/]+)$/.exec(path);
  if (srcIdMatch && (method === 'GET' || method === 'DELETE')) {
    const accountId = currentAccountId(req, sys);
    if (!accountId || !(await sys.service.getAccount(accountId))) {
      sendJson(res, 401, { error: 'not_authenticated' });
      return true;
    }
    const id = decodeURIComponent(srcIdMatch[1]!);

    if (method === 'GET') {
      const source = await sys.service.getSource(accountId, id);
      if (!source) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      sendJson(res, 200, { source }); // full source incl. text (to reload into the library)
      return true;
    }

    // DELETE — frees byte quota.
    const removed = await sys.service.deleteSource(accountId, id);
    if (!removed) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    sendJson(res, 200, { ok: true, quota: await sys.service.sourceQuotaStatus(accountId) });
    return true;
  }

  return false; // not an account route — fall through to static / 404
}
