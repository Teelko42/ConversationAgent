/**
 * `AccountService` — the account business logic, composed over the swappable
 * `AccountRepository`, the per-tier `Entitlement` table, and the fail-closed
 * `checkQuota` (New_Feature.md §2/§3/§5). The server's HTTP handlers call only
 * this; it is the single place that:
 *
 *   • maps a federated `ExternalIdentity` onto an `Account` + linked `Identity`
 *     (creating a Free account on first sign-in, reusing it thereafter);
 *   • computes the `QuotaStatus` the UI renders ("X of N resources used");
 *   • persists a "resource" (saved session + its artifacts) ONLY when under the
 *     tier cap — throwing a typed `QuotaExceededError` otherwise (hard reject);
 *   • reads/lists/deletes resources strictly scoped to the owning account.
 *
 * Identifiers + the clock are injectable so the whole service is deterministic in
 * tests (mirroring the stub providers' no-RNG/no-clock posture).
 */
import { randomUUID } from 'node:crypto';
import {
  AccountSchema,
  IdentitySchema,
  SavedSessionSchema,
  type Account,
  type Entitlement,
  type Identity,
  type QuotaStatus,
  type SavedSession,
  type StoredArtifact,
  type Tier,
} from '@aizen/contracts';
import type { ExternalIdentity } from './auth-provider.js';
import type { AccountRepository } from './repository.js';
import { DEFAULT_ENTITLEMENTS, entitlementFor, retentionDeadlineUs } from './entitlements.js';
import { checkQuota } from './quota.js';

export interface AccountServiceOptions {
  repo: AccountRepository;
  /** Per-tier entitlement table (defaults to the seed `DEFAULT_ENTITLEMENTS`). */
  entitlements?: Record<Tier, Entitlement>;
  /** Tier assigned to a brand-new account on first sign-in (default 'free'). */
  defaultTier?: Tier;
  /** Inject id generation (tests); defaults to `crypto.randomUUID`. */
  genId?: () => string;
  /** Inject the clock as ms epoch (tests); defaults to `Date.now`. */
  nowMs?: () => number;
}

/** One artifact to persist with a saved session (the bus payload + its family). */
export interface ArtifactInput {
  id?: string;
  kind: StoredArtifact['kind'];
  payload: unknown;
}

export interface SaveResourceInput {
  /** The live session id being saved (becomes the SavedSession id). */
  sessionId: string;
  title: string;
  /** Carried forward from the live session's consent context (team-09). */
  consentClass: SavedSession['consent_class'];
  piiPresent: boolean;
  artifacts?: ArtifactInput[];
}

export class AccountService {
  private readonly repo: AccountRepository;
  private readonly entitlements: Record<Tier, Entitlement>;
  private readonly defaultTier: Tier;
  private readonly genId: () => string;
  private readonly nowMs: () => number;

  constructor(opts: AccountServiceOptions) {
    this.repo = opts.repo;
    this.entitlements = opts.entitlements ?? DEFAULT_ENTITLEMENTS;
    this.defaultTier = opts.defaultTier ?? 'free';
    this.genId = opts.genId ?? randomUUID;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  private nowUs(): number {
    return this.nowMs() * 1000;
  }

  entitlement(tier: Tier): Entitlement {
    return entitlementFor(tier, this.entitlements);
  }

  async getAccount(id: string): Promise<Account | null> {
    return this.repo.getAccount(id);
  }

  async getIdentitiesForAccount(accountId: string): Promise<Identity[]> {
    return this.repo.listIdentitiesForAccount(accountId);
  }

  /**
   * Map a provider's `ExternalIdentity` onto an account. Returns the existing
   * account when the `(provider, subject)` link is already known; otherwise mints
   * a new Free account + identity. The returned identity always reflects the
   * latest email/name from the provider.
   */
  async upsertIdentity(ext: ExternalIdentity): Promise<{ account: Account; identity: Identity }> {
    const existing = await this.repo.getIdentityByProviderSubject(ext.provider, ext.subject);
    if (existing) {
      const account = await this.repo.getAccount(existing.account_id);
      if (account) {
        // refresh the human-facing fields from the IdP, keep ids/links stable.
        const identity = IdentitySchema.parse({
          ...existing,
          email: ext.email,
          display_name: ext.displayName,
        });
        await this.repo.upsertIdentity(identity);
        return { account, identity };
      }
      // identity orphaned (account missing) — fall through and re-create cleanly.
    }

    const nowUs = this.nowUs();
    const accountId = this.genId();
    const account = AccountSchema.parse({
      id: accountId,
      tier: this.defaultTier,
      workspace_id: accountId, // Phase 0: the account is its own workspace.
      display_name: ext.displayName,
      created_at_us: nowUs,
      updated_at_us: nowUs,
    });
    const identity = IdentitySchema.parse({
      id: this.genId(),
      account_id: accountId,
      provider: ext.provider,
      provider_subject: ext.subject,
      email: ext.email,
      display_name: ext.displayName,
      created_at_us: nowUs,
    });
    await this.repo.createAccount(account);
    await this.repo.upsertIdentity(identity);
    return { account, identity };
  }

  /** The quota view for an account ("X of N resources used"). */
  async quotaStatus(accountId: string): Promise<QuotaStatus> {
    const account = await this.repo.getAccount(accountId);
    const tier: Tier = account?.tier ?? this.defaultTier;
    const ent = this.entitlement(tier);
    const used = await this.repo.countSavedSessions(accountId);
    const limit = ent.max_resources;
    return {
      tier,
      used,
      limit,
      retention_window_days: ent.retention_window_days,
      exceeded: limit !== null && used >= limit,
    };
  }

  /**
   * Persist a resource (saved session + artifacts), enforcing the tier cap
   * fail-closed. Re-saving an already-saved session for the same account UPDATES
   * it (no quota change). A first save that would exceed the cap throws a typed
   * `QuotaExceededError` (hard reject — New_Feature.md §5).
   */
  async saveResource(accountId: string, input: SaveResourceInput): Promise<SavedSession> {
    const account = await this.repo.getAccount(accountId);
    if (!account) throw new Error('saveResource: unknown account');
    const ent = this.entitlement(account.tier);

    const already = await this.repo.getSavedSession(accountId, input.sessionId);
    if (!already) {
      // New resource → enforce the cap before creating anything (fail-closed).
      const used = await this.repo.countSavedSessions(accountId);
      const verdict = checkQuota(account.tier, used, ent.max_resources);
      if (!verdict.ok) throw verdict.error;
    }

    const nowUs = this.nowUs();
    const artifacts = input.artifacts ?? [];
    const session = SavedSessionSchema.parse({
      id: input.sessionId,
      account_id: accountId,
      title: input.title || 'Untitled session',
      artifact_count: artifacts.length,
      consent_class: input.consentClass,
      pii_present: input.piiPresent,
      created_at_us: already?.created_at_us ?? nowUs,
      updated_at_us: nowUs,
      expires_at_us: already?.expires_at_us ?? retentionDeadlineUs(ent, nowUs),
    });
    await this.repo.createSavedSession(session);

    if (artifacts.length > 0) {
      const stored: StoredArtifact[] = artifacts.map((a, i) => ({
        id: a.id ?? `${a.kind}-${i}`,
        account_id: accountId,
        session_id: input.sessionId,
        kind: a.kind,
        payload: a.payload,
        created_at_us: nowUs,
      }));
      await this.repo.addArtifacts(stored);
    }
    return session;
  }

  async listResources(accountId: string): Promise<SavedSession[]> {
    return this.repo.listSavedSessions(accountId);
  }

  async getResource(accountId: string, id: string): Promise<SavedSession | null> {
    return this.repo.getSavedSession(accountId, id);
  }

  async listArtifacts(accountId: string, sessionId: string): Promise<StoredArtifact[]> {
    return this.repo.listArtifacts(accountId, sessionId);
  }

  async deleteResource(accountId: string, id: string): Promise<boolean> {
    return this.repo.deleteSavedSession(accountId, id);
  }
}
