import { z } from 'zod';
import { ConsentClassSchema } from './consent.js';

/**
 * Account / identity / entitlement contracts (New_Feature.md §2).
 *
 * These make Aizen no longer anonymous-only: a user signs in via OAuth, gets a
 * persistent `Account`, and that account owns a bounded set of **resources**
 * (saved sessions + their artifacts). How many resources an account may keep is
 * gated by its `Entitlement`, which is keyed by `Tier` and seeded from the
 * team-10 §1.2 packaging table + §5.3 cost model.
 *
 * Conventions match every other contract in this package: a zod schema (runtime
 * validation), an inferred static type, and a JSON Schema exported to the
 * registry by `scripts/export-schema.ts` (D06 — one source of truth, referenced
 * by name only).
 *
 * Security posture (team-09): an account ADDS to, never bypasses, the consent +
 * retention model. A saved resource carries the live session's `consent_class` /
 * `pii_present` forward and an `expires_at_us` derived from the tier's retention
 * window — the cap is the *concurrent* ceiling, retention still expires data.
 */

/** Packaging tier (team-10 §1.2 / §5.1). Drives the entitlement + model cap. */
export const TierSchema = z.enum(['free', 'pro', 'team', 'enterprise']);
export type Tier = z.infer<typeof TierSchema>;

/** Which sign-in seam produced an identity. `stub` = the no-key demo provider. */
export const AuthProviderKindSchema = z.enum(['stub', 'google', 'microsoft']);
export type AuthProviderKind = z.infer<typeof AuthProviderKindSchema>;

/**
 * A persistent account. One account may have several linked `Identity`s (e.g. the
 * same person signing in with Google and with Microsoft). The account — not the
 * identity — owns resources and carries the tier/quota.
 *
 * `workspace_id` is forward-compat for Team "pooled per shared workspace" quota
 * (team-10 §1.2). Team shared workspaces are out of scope for Phase 0
 * (New_Feature.md "Out of scope"), so it defaults to the account's own id and the
 * Team cap is pooled at the account level for now.
 */
export const AccountSchema = z.object({
  id: z.string().uuid(),
  tier: TierSchema,
  /** Pooling key for Team-tier quota; Phase 0 == the account's own id. */
  workspace_id: z.string().uuid(),
  display_name: z.string().nullable(),
  created_at_us: z.number().int().nonnegative(),
  updated_at_us: z.number().int().nonnegative(),
});
export type Account = z.infer<typeof AccountSchema>;

/**
 * A federated identity linked to an account. `(provider, provider_subject)` is the
 * stable, unique key an OAuth provider hands back (`sub`); we look up an existing
 * link by it on every sign-in and create the account+identity on first sight.
 */
export const IdentitySchema = z.object({
  id: z.string().uuid(),
  account_id: z.string().uuid(),
  provider: AuthProviderKindSchema,
  /** The provider's stable subject id (`sub`); unique within a provider. */
  provider_subject: z.string().min(1),
  email: z.string().nullable(),
  display_name: z.string().nullable(),
  created_at_us: z.number().int().nonnegative(),
});
export type Identity = z.infer<typeof IdentitySchema>;

/**
 * Per-tier entitlement / quota descriptor. The values are SEEDED from this
 * package's defaults (see `@aizen/accounts` `DEFAULT_ENTITLEMENTS`) and persisted,
 * so a tier's caps can be tuned without a schema change (New_Feature.md §2).
 *
 *   • `max_resources`        — concurrent ceiling on stored saved-sessions.
 *                              `null` == configurable-by-contract (Enterprise).
 *   • `retention_window_days`— how long a saved resource is retained (team-09 §6).
 *                              `null` == configurable-by-contract (Enterprise).
 *   • `model_tier_cap`       — the LLM tier ceiling (team-10: Free = Haiku-only),
 *                              consumed by `@aizen/llm-gateway` `clampTier`.
 */
export const EntitlementSchema = z.object({
  tier: TierSchema,
  max_resources: z.number().int().nonnegative().nullable(),
  retention_window_days: z.number().int().positive().nullable(),
  model_tier_cap: z.enum(['haiku', 'sonnet', 'opus']),
  /** Human-readable note tying the numbers back to the packaging table. */
  notes: z.string(),
});
export type Entitlement = z.infer<typeof EntitlementSchema>;

/**
 * A persisted "resource": one saved conversation session owned by an account. It
 * is the unit the per-tier quota counts (New_Feature.md §2). Artifacts the session
 * produced (transcript segments, concept cards, KG nodes/edges, insights) are
 * stored separately, each stamped with the same `account_id` for isolation.
 *
 * `consent_class` / `pii_present` are carried forward from the live session so the
 * account layer never relaxes the team-09 consent posture. `expires_at_us` is the
 * retention deadline derived from the tier's `retention_window_days` (the sweep
 * itself is a documented Phase-1 job, MAN-F04-001).
 */
export const SavedSessionSchema = z.object({
  id: z.string().uuid(), // == the live session_id it was saved from
  account_id: z.string().uuid(),
  title: z.string(),
  artifact_count: z.number().int().nonnegative(),
  consent_class: ConsentClassSchema,
  pii_present: z.boolean(),
  created_at_us: z.number().int().nonnegative(),
  updated_at_us: z.number().int().nonnegative(),
  /** Retention deadline from the tier window; null == retained until configured. */
  expires_at_us: z.number().int().nonnegative().nullable(),
});
export type SavedSession = z.infer<typeof SavedSessionSchema>;

/** One stored artifact belonging to a saved session (and thus to an account). */
export const StoredArtifactSchema = z.object({
  id: z.string(),
  account_id: z.string().uuid(),
  session_id: z.string().uuid(),
  /** The canonical contract family this artifact came from. */
  kind: z.enum(['transcript_segment', 'concept_card', 'kg_node', 'kg_edge', 'insight_item']),
  /** The artifact payload as it was on the bus (validated by its own contract). */
  payload: z.unknown(),
  created_at_us: z.number().int().nonnegative(),
});
export type StoredArtifact = z.infer<typeof StoredArtifactSchema>;

/**
 * The quota view the UI renders ("X of N resources used") and the server returns
 * from `GET /api/session`. `limit: null` == unmetered/configurable (Enterprise).
 */
export const QuotaStatusSchema = z.object({
  tier: TierSchema,
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  retention_window_days: z.number().int().positive().nullable(),
  /** true when `limit` is set and `used >= limit` — the over-quota state. */
  exceeded: z.boolean(),
});
export type QuotaStatus = z.infer<typeof QuotaStatusSchema>;

/**
 * The typed, user-legible error body returned when a create-resource request is
 * rejected for being over the tier cap (New_Feature.md §5 — fail-closed hard
 * reject). `@aizen/accounts` throws a `QuotaExceededError` that serializes to this.
 */
export const QuotaErrorSchema = z.object({
  error: z.literal('quota_exceeded'),
  tier: TierSchema,
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  message: z.string(),
  /** What the user can do about it (upgrade, or delete a saved session). */
  remedy: z.string(),
});
export type QuotaError = z.infer<typeof QuotaErrorSchema>;
