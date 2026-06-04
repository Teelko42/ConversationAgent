/**
 * Quota enforcement — the "so many resources" part (New_Feature.md §5). The check
 * is **fail-closed and a hard reject**: creating a resource when the account is at
 * its tier's cap throws a typed `QuotaExceededError` (no soft cap, no silent
 * eviction — the resolved decision in §5). The error serializes to the
 * `QuotaError` contract so the server can return a clear, user-legible body with a
 * path to upgrade or delete.
 */
import type { QuotaError, Tier } from '@aizen/contracts';

/**
 * Thrown by the account service when a create-resource request would exceed the
 * tier cap. Carries the structured `QuotaError` body so the HTTP layer just
 * serializes `.body` with a 409.
 */
export class QuotaExceededError extends Error {
  readonly body: QuotaError;
  constructor(tier: Tier, used: number, limit: number) {
    const message = `Resource quota reached for the ${tier} tier: ${used} of ${limit} saved sessions used.`;
    super(message);
    this.name = 'QuotaExceededError';
    this.body = {
      error: 'quota_exceeded',
      tier,
      used,
      limit,
      message,
      remedy:
        tier === 'enterprise'
          ? 'Contact your administrator to raise the configured limit.'
          : 'Delete a saved session to free a slot, or upgrade your plan for a higher cap.',
    };
  }
}

/**
 * Fail-closed admission check. Returns ok when there is headroom; otherwise the
 * caller must reject. A `null` limit means unmetered (Enterprise configurable) —
 * always allowed. Pure + side-effect-free so it is trivially testable.
 */
export function checkQuota(
  tier: Tier,
  used: number,
  limit: number | null,
): { ok: true } | { ok: false; error: QuotaExceededError } {
  if (limit === null) return { ok: true };
  if (used >= limit) return { ok: false, error: new QuotaExceededError(tier, used, limit) };
  return { ok: true };
}
