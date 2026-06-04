/**
 * Per-tier entitlements — the quota + retention + model-tier caps, keyed by tier
 * (New_Feature.md §2). These are the SEED values: the repository persists a copy
 * so they can be tuned without a schema change, and `entitlementFor` is the single
 * read point so no cap is ever hard-coded at a call site.
 *
 * The numbers are derived from team-10 §1.2 (packaging) and §5.3 (cost model):
 *
 *   | Tier       | Max stored resources | Retention | Model cap | Source            |
 *   |------------|----------------------|-----------|-----------|-------------------|
 *   | Free       | 5 saved sessions     | 7 days    | haiku     | §1.2 (Haiku-only) |
 *   | Pro        | 200 saved sessions   | 12 months | opus      | §1.2 "long ret."  |
 *   | Team       | 1,000 (pooled)       | 12 months | opus      | §1.2 shared ws    |
 *   | Enterprise | configurable (null)  | config.   | opus      | team-09 controls  |
 *
 * "Pooled per shared workspace" for Team resolves to the account level in Phase 0
 * (Team shared workspaces are out of scope, New_Feature.md "Out of scope").
 */
import type { Entitlement, Tier } from '@aizen/contracts';

const DAYS_PER_YEAR = 365;

/** The seed entitlement table. Persisted on first run; tunable thereafter. */
export const DEFAULT_ENTITLEMENTS: Record<Tier, Entitlement> = {
  free: {
    tier: 'free',
    max_resources: 5,
    retention_window_days: 7,
    model_tier_cap: 'haiku',
    notes: 'Free: 5 saved sessions, 7-day retention, Haiku-only (team-10 §1.2/§5.3).',
  },
  pro: {
    tier: 'pro',
    max_resources: 200,
    retention_window_days: 12 * 30, // ~12 months
    model_tier_cap: 'opus',
    notes: 'Pro: 200 saved sessions, long retention, full Sonnet+Opus (team-10 §1.2). Fair-use, not "unlimited" (C-9).',
  },
  team: {
    tier: 'team',
    max_resources: 1000,
    retention_window_days: DAYS_PER_YEAR,
    model_tier_cap: 'opus',
    notes: 'Team: 1,000 pooled saved sessions (per workspace; account-level in Phase 0), long retention (team-10 §1.2).',
  },
  enterprise: {
    tier: 'enterprise',
    max_resources: null, // configurable by contract
    retention_window_days: null, // configurable by contract (team-09)
    model_tier_cap: 'opus',
    notes: 'Enterprise: configurable caps + retention per team-09 controls.',
  },
};

/**
 * Resolve a tier's entitlement from a (possibly tuned) table, falling back to the
 * seed defaults. Keeping this the single read point means a call site can never
 * accidentally hard-code a number — it asks for the tier and gets the policy.
 */
export function entitlementFor(
  tier: Tier,
  table: Record<Tier, Entitlement> = DEFAULT_ENTITLEMENTS,
): Entitlement {
  return table[tier] ?? DEFAULT_ENTITLEMENTS[tier];
}

/** Wall-clock µs `retention_window_days` after `fromUs`, or null if unbounded. */
export function retentionDeadlineUs(ent: Entitlement, fromUs: number): number | null {
  if (ent.retention_window_days === null) return null;
  return fromUs + ent.retention_window_days * 24 * 60 * 60 * 1_000_000;
}
