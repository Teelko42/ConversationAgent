/**
 * The account persistence seam (New_Feature.md §4). Business logic (the service,
 * quota, auth) talks ONLY to this interface — never to a concrete store — so the
 * backing store is swappable: `InMemoryAccountRepository` (here) for tests/ephemeral
 * runs, `SqliteAccountRepository` (repository-sqlite.ts) for the Phase-0 file DB,
 * and `PgAccountRepository` (repository-postgres.ts) for the Azure Phase-1+ target
 * (team-08). No store-specific detail (SQL, driver) leaks past an implementation.
 *
 * The interface is **async** (every method returns a Promise). SQLite (node:sqlite)
 * is synchronous and the in-memory store is trivially so, but a real network DB
 * (PostgreSQL via node-postgres) is not — so the seam is async and the two
 * synchronous stores simply resolve immediately. The service `await`s every call.
 *
 * Resource reads are **account-scoped at the data layer**: `getSavedSession`,
 * `listSavedSessions`, `deleteSavedSession`, `listArtifacts`, and the F3 Phase-B
 * stored-source methods all take the `accountId` and only ever return that account's
 * rows — so cross-account access is structurally impossible, not just filtered in a
 * handler (team-09 T6).
 */
import type { Account, Identity, SavedSession, StoredArtifact, StoredSource } from '@aizen/contracts';

export interface AccountRepository {
  // --- accounts + identities (the control plane) ---
  createAccount(account: Account): Promise<void>;
  getAccount(id: string): Promise<Account | null>;
  updateAccountTier(id: string, tier: Account['tier'], updatedAtUs: number): Promise<void>;

  upsertIdentity(identity: Identity): Promise<void>;
  getIdentityByProviderSubject(provider: Identity['provider'], subject: string): Promise<Identity | null>;
  listIdentitiesForAccount(accountId: string): Promise<Identity[]>;

  // --- resources (saved sessions), the quota unit ---
  createSavedSession(session: SavedSession): Promise<void>;
  /** Scoped: returns the session only if it belongs to `accountId`, else null. */
  getSavedSession(accountId: string, id: string): Promise<SavedSession | null>;
  listSavedSessions(accountId: string): Promise<SavedSession[]>;
  /** The live quota count for an account (the cap is checked against this). */
  countSavedSessions(accountId: string): Promise<number>;
  /** Scoped delete; returns true iff a row owned by `accountId` was removed. */
  deleteSavedSession(accountId: string, id: string): Promise<boolean>;

  // --- artifacts (owned transitively via their saved session) ---
  addArtifacts(artifacts: StoredArtifact[]): Promise<void>;
  /** Scoped: artifacts of `sessionId` only if that session belongs to `accountId`. */
  listArtifacts(accountId: string, sessionId: string): Promise<StoredArtifact[]>;

  // --- stored sources (F3 Phase B), the byte-metered quota unit. All scoped. ---
  /** Insert or replace a stored source (keyed by its id, owned by `account_id`). */
  addSource(source: StoredSource): Promise<void>;
  /** Scoped: returns the source only if it belongs to `accountId`, else null. */
  getSource(accountId: string, id: string): Promise<StoredSource | null>;
  /** Scoped: all of an account's stored sources, newest first. */
  listSources(accountId: string): Promise<StoredSource[]>;
  /** Scoped: how many stored sources an account has. */
  countSources(accountId: string): Promise<number>;
  /** Scoped: total `bytes` across an account's stored sources (the quota measure). */
  sumSourceBytes(accountId: string): Promise<number>;
  /** Scoped delete; returns true iff a row owned by `accountId` was removed. */
  deleteSource(accountId: string, id: string): Promise<boolean>;

  /** Release any underlying resource (DB pool / file handle). Optional. */
  close?(): Promise<void> | void;
}

/**
 * In-memory repository — the deterministic, dependency-free default (mirrors the
 * stub providers). Proves the seam is real: the service/quota/auth code runs
 * unchanged against this, the SQLite store, or Postgres. Used by tests and as the
 * fallback when no DB is configured / `node:sqlite` is unavailable. The methods are
 * `async` only to satisfy the seam — they never actually suspend.
 */
export class InMemoryAccountRepository implements AccountRepository {
  private readonly accounts = new Map<string, Account>();
  private readonly identities = new Map<string, Identity>(); // key: `${provider}:${subject}`
  private readonly sessions = new Map<string, SavedSession>(); // key: session id
  private readonly artifacts: StoredArtifact[] = [];
  private readonly storedSources = new Map<string, StoredSource>(); // key: source id

  private static idKey(provider: string, subject: string): string {
    return `${provider}:${subject}`;
  }

  async createAccount(account: Account): Promise<void> {
    this.accounts.set(account.id, { ...account });
  }

  async getAccount(id: string): Promise<Account | null> {
    const a = this.accounts.get(id);
    return a ? { ...a } : null;
  }

  async updateAccountTier(id: string, tier: Account['tier'], updatedAtUs: number): Promise<void> {
    const a = this.accounts.get(id);
    if (a) this.accounts.set(id, { ...a, tier, updated_at_us: updatedAtUs });
  }

  async upsertIdentity(identity: Identity): Promise<void> {
    this.identities.set(InMemoryAccountRepository.idKey(identity.provider, identity.provider_subject), {
      ...identity,
    });
  }

  async getIdentityByProviderSubject(provider: Identity['provider'], subject: string): Promise<Identity | null> {
    const i = this.identities.get(InMemoryAccountRepository.idKey(provider, subject));
    return i ? { ...i } : null;
  }

  async listIdentitiesForAccount(accountId: string): Promise<Identity[]> {
    return [...this.identities.values()].filter((i) => i.account_id === accountId).map((i) => ({ ...i }));
  }

  async createSavedSession(session: SavedSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async getSavedSession(accountId: string, id: string): Promise<SavedSession | null> {
    const s = this.sessions.get(id);
    return s && s.account_id === accountId ? { ...s } : null;
  }

  async listSavedSessions(accountId: string): Promise<SavedSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.account_id === accountId)
      .sort((a, b) => b.created_at_us - a.created_at_us)
      .map((s) => ({ ...s }));
  }

  async countSavedSessions(accountId: string): Promise<number> {
    let n = 0;
    for (const s of this.sessions.values()) if (s.account_id === accountId) n++;
    return n;
  }

  async deleteSavedSession(accountId: string, id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.account_id !== accountId) return false;
    this.sessions.delete(id);
    // cascade: drop the session's artifacts too (team-09 §6 — delete cascades).
    for (let i = this.artifacts.length - 1; i >= 0; i--) {
      const art = this.artifacts[i];
      if (art && art.session_id === id && art.account_id === accountId) this.artifacts.splice(i, 1);
    }
    return true;
  }

  async addArtifacts(artifacts: StoredArtifact[]): Promise<void> {
    for (const a of artifacts) this.artifacts.push({ ...a });
  }

  async listArtifacts(accountId: string, sessionId: string): Promise<StoredArtifact[]> {
    // Scoped: only if the session belongs to this account (else nothing).
    const owned = this.sessions.get(sessionId);
    if (!owned || owned.account_id !== accountId) return [];
    return this.artifacts
      .filter((a) => a.session_id === sessionId && a.account_id === accountId)
      .map((a) => ({ ...a }));
  }

  // --- stored sources (F3 Phase B) — all reads filtered by account_id ---
  async addSource(source: StoredSource): Promise<void> {
    this.storedSources.set(source.id, { ...source });
  }

  async getSource(accountId: string, id: string): Promise<StoredSource | null> {
    const s = this.storedSources.get(id);
    return s && s.account_id === accountId ? { ...s } : null;
  }

  async listSources(accountId: string): Promise<StoredSource[]> {
    return [...this.storedSources.values()]
      .filter((s) => s.account_id === accountId)
      .sort((a, b) => b.created_at_us - a.created_at_us)
      .map((s) => ({ ...s }));
  }

  async countSources(accountId: string): Promise<number> {
    let n = 0;
    for (const s of this.storedSources.values()) if (s.account_id === accountId) n++;
    return n;
  }

  async sumSourceBytes(accountId: string): Promise<number> {
    let total = 0;
    for (const s of this.storedSources.values()) if (s.account_id === accountId) total += s.bytes;
    return total;
  }

  async deleteSource(accountId: string, id: string): Promise<boolean> {
    const s = this.storedSources.get(id);
    if (!s || s.account_id !== accountId) return false;
    this.storedSources.delete(id);
    return true;
  }
}
