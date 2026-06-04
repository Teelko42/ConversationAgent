/**
 * SQLite implementation of `AccountRepository` (New_Feature.md §4) — the Phase-0
 * single-file store. It uses Node's **built-in** `node:sqlite` (Node ≥ 22.5), so
 * there is no native build step and nothing to `pnpm install` — the same SQLite
 * engine, zero extra dependency. (`better-sqlite3` would behave identically behind
 * this interface; it was not adopted to avoid a node-gyp/MSVC build on Windows.)
 *
 * `node:sqlite` is lazy-loaded via `createRequire` rather than a static
 * `import … from 'node:sqlite'` for two reasons: (1) the pinned `@types/node@20`
 * predates its type declarations, and (2) on a Node older than 22.5 the require
 * throws — which `openAccountDb` catches so the app falls back to the in-memory
 * store and still boots (BD-03 fail-open posture). No SQLite specifics leak past
 * this file; the service only ever sees the `AccountRepository` interface.
 *
 * The store engine is synchronous, but the `AccountRepository` seam is async (so a
 * network DB like Postgres can implement it too); the methods here are therefore
 * `async` wrappers that resolve immediately around the synchronous `node:sqlite`
 * calls.
 */
import { createRequire } from 'node:module';
import type { Account, Identity, SavedSession, StoredArtifact } from '@aizen/contracts';
import type { AccountRepository } from './repository.js';

/** The minimal `node:sqlite` surface we use (typed locally; see header note). */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type DatabaseSyncCtor = new (path: string) => SqliteDb;

function loadDatabaseSync(): DatabaseSyncCtor {
  const require = createRequire(import.meta.url);
  const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
  return mod.DatabaseSync;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  created_at_us INTEGER NOT NULL,
  updated_at_us INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  created_at_us INTEGER NOT NULL,
  UNIQUE(provider, provider_subject)
);
CREATE TABLE IF NOT EXISTS saved_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artifact_count INTEGER NOT NULL,
  consent_class TEXT NOT NULL,
  pii_present INTEGER NOT NULL,
  created_at_us INTEGER NOT NULL,
  updated_at_us INTEGER NOT NULL,
  expires_at_us INTEGER
);
CREATE INDEX IF NOT EXISTS idx_saved_account ON saved_sessions(account_id);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at_us INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, account_id);
`;

export class SqliteAccountRepository implements AccountRepository {
  private readonly db: SqliteDb;

  /** Open (or create) the DB at `path`. Use ':memory:' for an ephemeral store. */
  constructor(path: string, ctor: DatabaseSyncCtor = loadDatabaseSync()) {
    this.db = new ctor(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  async createAccount(account: Account): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO accounts (id, tier, workspace_id, display_name, created_at_us, updated_at_us)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tier=excluded.tier, workspace_id=excluded.workspace_id,
           display_name=excluded.display_name, updated_at_us=excluded.updated_at_us`,
      )
      .run(
        account.id,
        account.tier,
        account.workspace_id,
        account.display_name,
        account.created_at_us,
        account.updated_at_us,
      );
  }

  async getAccount(id: string): Promise<Account | null> {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
    return row ? rowToAccount(row) : null;
  }

  async updateAccountTier(id: string, tier: Account['tier'], updatedAtUs: number): Promise<void> {
    this.db
      .prepare(`UPDATE accounts SET tier = ?, updated_at_us = ? WHERE id = ?`)
      .run(tier, updatedAtUs, id);
  }

  async upsertIdentity(identity: Identity): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO identities (id, account_id, provider, provider_subject, email, display_name, created_at_us)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_subject) DO UPDATE SET
           account_id=excluded.account_id, email=excluded.email, display_name=excluded.display_name`,
      )
      .run(
        identity.id,
        identity.account_id,
        identity.provider,
        identity.provider_subject,
        identity.email,
        identity.display_name,
        identity.created_at_us,
      );
  }

  async getIdentityByProviderSubject(provider: Identity['provider'], subject: string): Promise<Identity | null> {
    const row = this.db
      .prepare(`SELECT * FROM identities WHERE provider = ? AND provider_subject = ?`)
      .get(provider, subject);
    return row ? rowToIdentity(row) : null;
  }

  async listIdentitiesForAccount(accountId: string): Promise<Identity[]> {
    return this.db
      .prepare(`SELECT * FROM identities WHERE account_id = ? ORDER BY created_at_us`)
      .all(accountId)
      .map(rowToIdentity);
  }

  async createSavedSession(session: SavedSession): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO saved_sessions
           (id, account_id, title, artifact_count, consent_class, pii_present, created_at_us, updated_at_us, expires_at_us)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, artifact_count=excluded.artifact_count,
           consent_class=excluded.consent_class, pii_present=excluded.pii_present,
           updated_at_us=excluded.updated_at_us, expires_at_us=excluded.expires_at_us`,
      )
      .run(
        session.id,
        session.account_id,
        session.title,
        session.artifact_count,
        session.consent_class,
        session.pii_present ? 1 : 0,
        session.created_at_us,
        session.updated_at_us,
        session.expires_at_us,
      );
  }

  async getSavedSession(accountId: string, id: string): Promise<SavedSession | null> {
    const row = this.db
      .prepare(`SELECT * FROM saved_sessions WHERE id = ? AND account_id = ?`)
      .get(id, accountId);
    return row ? rowToSavedSession(row) : null;
  }

  async listSavedSessions(accountId: string): Promise<SavedSession[]> {
    return this.db
      .prepare(`SELECT * FROM saved_sessions WHERE account_id = ? ORDER BY created_at_us DESC`)
      .all(accountId)
      .map(rowToSavedSession);
  }

  async countSavedSessions(accountId: string): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM saved_sessions WHERE account_id = ?`)
      .get(accountId);
    return Number(row?.c ?? 0);
  }

  async deleteSavedSession(accountId: string, id: string): Promise<boolean> {
    const existed = await this.getSavedSession(accountId, id);
    if (!existed) return false;
    this.db.prepare(`DELETE FROM saved_sessions WHERE id = ? AND account_id = ?`).run(id, accountId);
    // cascade artifacts (team-09 §6 — delete cascades with the session).
    this.db.prepare(`DELETE FROM artifacts WHERE session_id = ? AND account_id = ?`).run(id, accountId);
    return true;
  }

  async addArtifacts(artifacts: StoredArtifact[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO artifacts (id, account_id, session_id, kind, payload, created_at_us)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, id) DO UPDATE SET payload=excluded.payload, kind=excluded.kind`,
    );
    for (const a of artifacts) {
      stmt.run(a.id, a.account_id, a.session_id, a.kind, JSON.stringify(a.payload ?? null), a.created_at_us);
    }
  }

  async listArtifacts(accountId: string, sessionId: string): Promise<StoredArtifact[]> {
    return this.db
      .prepare(
        `SELECT * FROM artifacts WHERE session_id = ? AND account_id = ? ORDER BY created_at_us`,
      )
      .all(sessionId, accountId)
      .map(rowToArtifact);
  }
}

/**
 * Open the SQLite repository, falling back to the in-memory store when
 * `node:sqlite` is unavailable (Node < 22.5) — so the app always boots. Returns
 * the repository plus which backend was actually used (for the startup banner).
 */
export function openAccountDb(
  path: string,
): { repo: AccountRepository; backend: 'sqlite' | 'memory' } | { repo: null; backend: 'memory' } {
  try {
    return { repo: new SqliteAccountRepository(path), backend: 'sqlite' };
  } catch {
    return { repo: null, backend: 'memory' };
  }
}

// --- row → contract mappers (the only place column shapes are read) ---
function str(v: unknown): string {
  return String(v ?? '');
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function num(v: unknown): number {
  return Number(v ?? 0);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function rowToAccount(r: Record<string, unknown>): Account {
  return {
    id: str(r.id),
    tier: str(r.tier) as Account['tier'],
    workspace_id: str(r.workspace_id),
    display_name: strOrNull(r.display_name),
    created_at_us: num(r.created_at_us),
    updated_at_us: num(r.updated_at_us),
  };
}

function rowToIdentity(r: Record<string, unknown>): Identity {
  return {
    id: str(r.id),
    account_id: str(r.account_id),
    provider: str(r.provider) as Identity['provider'],
    provider_subject: str(r.provider_subject),
    email: strOrNull(r.email),
    display_name: strOrNull(r.display_name),
    created_at_us: num(r.created_at_us),
  };
}

function rowToSavedSession(r: Record<string, unknown>): SavedSession {
  return {
    id: str(r.id),
    account_id: str(r.account_id),
    title: str(r.title),
    artifact_count: num(r.artifact_count),
    consent_class: str(r.consent_class) as SavedSession['consent_class'],
    pii_present: num(r.pii_present) !== 0,
    created_at_us: num(r.created_at_us),
    updated_at_us: num(r.updated_at_us),
    expires_at_us: numOrNull(r.expires_at_us),
  };
}

function rowToArtifact(r: Record<string, unknown>): StoredArtifact {
  let payload: unknown = null;
  try {
    payload = JSON.parse(str(r.payload));
  } catch {
    payload = null;
  }
  return {
    id: str(r.id),
    account_id: str(r.account_id),
    session_id: str(r.session_id),
    kind: str(r.kind) as StoredArtifact['kind'],
    payload,
    created_at_us: num(r.created_at_us),
  };
}
