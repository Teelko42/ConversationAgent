/**
 * PostgreSQL implementation of `AccountRepository` (New_Feature.md §4 / team-08) —
 * the Phase-1+ store that replaces the single-file SQLite DB when the app runs on
 * Azure (Azure Database for PostgreSQL Flexible Server). It implements the SAME
 * `AccountRepository` interface as the SQLite + in-memory stores, so the
 * service / quota / auth code runs against it unchanged. Reads stay account-scoped
 * at the data layer (team-09 T6); no SQL leaks past this file.
 *
 * Unlike SQLite (`node:sqlite`, synchronous), node-postgres is asynchronous — which
 * is why the whole `AccountRepository` interface returns Promises. The connection is
 * a pooled `pg.Pool`; the schema is created idempotently on `open()`
 * (`CREATE TABLE IF NOT EXISTS …`), so first boot against an empty database
 * self-provisions and re-boot is a no-op.
 *
 * Dialect notes vs. the SQLite schema (kept byte-for-byte equivalent in meaning):
 *   • placeholders are `$1, $2, …` (not `?`), and upserts use `ON CONFLICT … DO
 *     UPDATE SET col = EXCLUDED.col`;
 *   • `pii_present` is a real `BOOLEAN` (not 0/1);
 *   • microsecond timestamps are `BIGINT` — node-postgres returns BIGINT as a
 *     *string* to avoid precision loss, so the row mappers coerce with `Number()`
 *     (our values are < 2^53 microseconds, so they stay exact);
 *   • `payload` is `JSONB` — node-postgres parses it back to a JS value on read, so
 *     the mapper takes it as-is and the writer `JSON.stringify`s + casts (`$n::jsonb`).
 *
 * Azure note: Flexible Server requires TLS. Pass `ssl` (e.g.
 * `{ rejectUnauthorized: false }` for the simplest setup, or the Azure CA for full
 * verification) or a `sslmode=require` connection string. `buildAccountSystem`
 * (server) enables TLS automatically when the URL asks for it.
 */
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import type { Account, Identity, SavedSession, StoredArtifact, StoredSource } from '@aizen/contracts';
import type { AccountRepository } from './repository.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  created_at_us BIGINT NOT NULL,
  updated_at_us BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  created_at_us BIGINT NOT NULL,
  UNIQUE (provider, provider_subject)
);
CREATE TABLE IF NOT EXISTS saved_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artifact_count INTEGER NOT NULL,
  consent_class TEXT NOT NULL,
  pii_present BOOLEAN NOT NULL,
  created_at_us BIGINT NOT NULL,
  updated_at_us BIGINT NOT NULL,
  expires_at_us BIGINT
);
CREATE INDEX IF NOT EXISTS idx_saved_account ON saved_sessions(account_id);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at_us BIGINT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, account_id);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  origin TEXT NOT NULL,
  mime TEXT,
  bytes BIGINT NOT NULL,
  text TEXT NOT NULL,
  consent_class TEXT NOT NULL,
  pii_present BOOLEAN NOT NULL,
  created_at_us BIGINT NOT NULL,
  updated_at_us BIGINT NOT NULL,
  expires_at_us BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sources_account ON sources(account_id);
`;

export interface PgOpenOptions {
  /** libpq-style URL, e.g. `postgresql://user:pwd@host:5432/aizen?sslmode=require`. */
  connectionString: string;
  /** TLS config. Omit to let the connection string decide. */
  ssl?: PoolConfig['ssl'];
  /** Max pooled connections (default node-postgres = 10). */
  max?: number;
}

export class PgAccountRepository implements AccountRepository {
  private readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Connect a pool and ensure the schema exists. Throws if the database is
   * unreachable — the server catches that and falls back to SQLite/in-memory so the
   * app still boots (BD-03 fail-open).
   */
  static async open(opts: PgOpenOptions): Promise<PgAccountRepository> {
    const cfg: PoolConfig = { connectionString: opts.connectionString };
    if (opts.ssl !== undefined) cfg.ssl = opts.ssl;
    if (opts.max !== undefined) cfg.max = opts.max;
    const pool = new Pool(cfg);
    const repo = new PgAccountRepository(pool);
    await pool.query(SCHEMA); // multi-statement DDL via the simple-query protocol
    return repo;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createAccount(account: Account): Promise<void> {
    await this.pool.query(
      `INSERT INTO accounts (id, tier, workspace_id, display_name, created_at_us, updated_at_us)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET tier=EXCLUDED.tier, workspace_id=EXCLUDED.workspace_id,
         display_name=EXCLUDED.display_name, updated_at_us=EXCLUDED.updated_at_us`,
      [
        account.id,
        account.tier,
        account.workspace_id,
        account.display_name,
        account.created_at_us,
        account.updated_at_us,
      ],
    );
  }

  async getAccount(id: string): Promise<Account | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM accounts WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToAccount(rows[0]) : null;
  }

  async updateAccountTier(id: string, tier: Account['tier'], updatedAtUs: number): Promise<void> {
    await this.pool.query(`UPDATE accounts SET tier = $1, updated_at_us = $2 WHERE id = $3`, [
      tier,
      updatedAtUs,
      id,
    ]);
  }

  async upsertIdentity(identity: Identity): Promise<void> {
    await this.pool.query(
      `INSERT INTO identities (id, account_id, provider, provider_subject, email, display_name, created_at_us)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider, provider_subject) DO UPDATE SET
         account_id=EXCLUDED.account_id, email=EXCLUDED.email, display_name=EXCLUDED.display_name`,
      [
        identity.id,
        identity.account_id,
        identity.provider,
        identity.provider_subject,
        identity.email,
        identity.display_name,
        identity.created_at_us,
      ],
    );
  }

  async getIdentityByProviderSubject(
    provider: Identity['provider'],
    subject: string,
  ): Promise<Identity | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM identities WHERE provider = $1 AND provider_subject = $2`,
      [provider, subject],
    );
    return rows[0] ? rowToIdentity(rows[0]) : null;
  }

  async listIdentitiesForAccount(accountId: string): Promise<Identity[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM identities WHERE account_id = $1 ORDER BY created_at_us`,
      [accountId],
    );
    return rows.map(rowToIdentity);
  }

  async createSavedSession(session: SavedSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO saved_sessions
         (id, account_id, title, artifact_count, consent_class, pii_present, created_at_us, updated_at_us, expires_at_us)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, artifact_count=EXCLUDED.artifact_count,
         consent_class=EXCLUDED.consent_class, pii_present=EXCLUDED.pii_present,
         updated_at_us=EXCLUDED.updated_at_us, expires_at_us=EXCLUDED.expires_at_us`,
      [
        session.id,
        session.account_id,
        session.title,
        session.artifact_count,
        session.consent_class,
        session.pii_present,
        session.created_at_us,
        session.updated_at_us,
        session.expires_at_us,
      ],
    );
  }

  async getSavedSession(accountId: string, id: string): Promise<SavedSession | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM saved_sessions WHERE id = $1 AND account_id = $2`,
      [id, accountId],
    );
    return rows[0] ? rowToSavedSession(rows[0]) : null;
  }

  async listSavedSessions(accountId: string): Promise<SavedSession[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM saved_sessions WHERE account_id = $1 ORDER BY created_at_us DESC`,
      [accountId],
    );
    return rows.map(rowToSavedSession);
  }

  async countSavedSessions(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM saved_sessions WHERE account_id = $1`,
      [accountId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  async deleteSavedSession(accountId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM saved_sessions WHERE id = $1 AND account_id = $2`,
      [id, accountId],
    );
    if (!res.rowCount) return false;
    // cascade artifacts (team-09 §6 — delete cascades with the session).
    await this.pool.query(`DELETE FROM artifacts WHERE session_id = $1 AND account_id = $2`, [
      id,
      accountId,
    ]);
    return true;
  }

  async addArtifacts(artifacts: StoredArtifact[]): Promise<void> {
    for (const a of artifacts) {
      await this.pool.query(
        `INSERT INTO artifacts (id, account_id, session_id, kind, payload, created_at_us)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (session_id, id) DO UPDATE SET payload=EXCLUDED.payload, kind=EXCLUDED.kind`,
        [a.id, a.account_id, a.session_id, a.kind, JSON.stringify(a.payload ?? null), a.created_at_us],
      );
    }
  }

  async listArtifacts(accountId: string, sessionId: string): Promise<StoredArtifact[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM artifacts WHERE session_id = $1 AND account_id = $2 ORDER BY created_at_us`,
      [sessionId, accountId],
    );
    return rows.map(rowToArtifact);
  }

  // --- stored sources (F3 Phase B) — all reads scoped by account_id ---
  async addSource(source: StoredSource): Promise<void> {
    await this.pool.query(
      `INSERT INTO sources
         (id, account_id, title, origin, mime, bytes, text, consent_class, pii_present, created_at_us, updated_at_us, expires_at_us)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, origin=EXCLUDED.origin, mime=EXCLUDED.mime,
         bytes=EXCLUDED.bytes, text=EXCLUDED.text, consent_class=EXCLUDED.consent_class,
         pii_present=EXCLUDED.pii_present, updated_at_us=EXCLUDED.updated_at_us, expires_at_us=EXCLUDED.expires_at_us`,
      [
        source.id,
        source.account_id,
        source.title,
        source.origin,
        source.mime ?? null,
        source.bytes,
        source.text,
        source.consent_class,
        source.pii_present,
        source.created_at_us,
        source.updated_at_us,
        source.expires_at_us,
      ],
    );
  }

  async getSource(accountId: string, id: string): Promise<StoredSource | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM sources WHERE id = $1 AND account_id = $2`,
      [id, accountId],
    );
    return rows[0] ? rowToSource(rows[0]) : null;
  }

  async listSources(accountId: string): Promise<StoredSource[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM sources WHERE account_id = $1 ORDER BY created_at_us DESC`,
      [accountId],
    );
    return rows.map(rowToSource);
  }

  async countSources(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM sources WHERE account_id = $1`,
      [accountId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  async sumSourceBytes(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ b: string }>(
      `SELECT COALESCE(SUM(bytes), 0) AS b FROM sources WHERE account_id = $1`,
      [accountId],
    );
    return Number(rows[0]?.b ?? 0);
  }

  async deleteSource(accountId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM sources WHERE id = $1 AND account_id = $2`, [
      id,
      accountId,
    ]);
    return !!res.rowCount;
  }

  /**
   * TEST-ONLY: clear every table. Used by the opt-in Postgres contract test
   * (`repository.test.ts`, enabled via `TEST_DATABASE_URL`) to start each case
   * from a clean slate. Not part of the `AccountRepository` interface.
   */
  async truncateAll(): Promise<void> {
    await this.pool.query('TRUNCATE sources, artifacts, saved_sessions, identities, accounts');
  }
}

// --- row → contract mappers (the only place column shapes are read) ---
function str(v: unknown): string {
  return String(v ?? '');
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
// BIGINT comes back as a string from node-postgres; Number() restores the value
// (our microsecond timestamps are < 2^53, so they stay exact).
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
    pii_present: Boolean(r.pii_present), // real BOOLEAN column
    created_at_us: num(r.created_at_us),
    updated_at_us: num(r.updated_at_us),
    expires_at_us: numOrNull(r.expires_at_us),
  };
}

function rowToArtifact(r: Record<string, unknown>): StoredArtifact {
  // JSONB is already parsed by node-postgres; tolerate a string just in case.
  let payload: unknown = r.payload ?? null;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
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

function rowToSource(r: Record<string, unknown>): StoredSource {
  const out: StoredSource = {
    id: str(r.id),
    account_id: str(r.account_id),
    title: str(r.title),
    origin: str(r.origin) as StoredSource['origin'],
    bytes: num(r.bytes), // BIGINT → string → Number (values < 2^53, exact)
    text: str(r.text),
    consent_class: str(r.consent_class) as StoredSource['consent_class'],
    pii_present: Boolean(r.pii_present), // real BOOLEAN column
    created_at_us: num(r.created_at_us),
    updated_at_us: num(r.updated_at_us),
    expires_at_us: numOrNull(r.expires_at_us),
  };
  const mime = strOrNull(r.mime);
  if (mime) out.mime = mime;
  return out;
}
