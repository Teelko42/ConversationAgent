import { describe, it, expect } from 'vitest';
import { checkQuota, QuotaExceededError } from './quota.js';
import { DEFAULT_ENTITLEMENTS, entitlementFor, retentionDeadlineUs } from './entitlements.js';

describe('checkQuota (fail-closed hard reject)', () => {
  it('allows under the cap and rejects at/over the cap with a typed error', () => {
    expect(checkQuota('free', 4, 5).ok).toBe(true);
    const atCap = checkQuota('free', 5, 5);
    expect(atCap.ok).toBe(false);
    if (!atCap.ok) {
      expect(atCap.error).toBeInstanceOf(QuotaExceededError);
      expect(atCap.error.body).toMatchObject({ error: 'quota_exceeded', tier: 'free', used: 5, limit: 5 });
      expect(atCap.error.body.remedy).toMatch(/delete|upgrade/i);
    }
  });

  it('treats a null limit (Enterprise configurable) as unmetered', () => {
    expect(checkQuota('enterprise', 9999, null).ok).toBe(true);
  });
});

describe('entitlements — caps match team-10 §1.2 / New_Feature.md §2', () => {
  it('Free 5 / Pro 200 / Team 1,000 / Enterprise configurable', () => {
    expect(entitlementFor('free').max_resources).toBe(5);
    expect(entitlementFor('pro').max_resources).toBe(200);
    expect(entitlementFor('team').max_resources).toBe(1000);
    expect(entitlementFor('enterprise').max_resources).toBeNull();
  });

  it('Free is Haiku-only with a 7-day retention window (team-10 §5.3)', () => {
    expect(entitlementFor('free').model_tier_cap).toBe('haiku');
    expect(entitlementFor('free').retention_window_days).toBe(7);
  });

  it('a tuned table overrides the seed defaults without touching call sites', () => {
    const tuned = { ...DEFAULT_ENTITLEMENTS, free: { ...DEFAULT_ENTITLEMENTS.free, max_resources: 10 } };
    expect(entitlementFor('free', tuned).max_resources).toBe(10);
  });

  it('retention deadline is null when the window is unbounded (Enterprise)', () => {
    expect(retentionDeadlineUs(entitlementFor('enterprise'), 1_000)).toBeNull();
    expect(retentionDeadlineUs(entitlementFor('free'), 0)).toBe(7 * 24 * 60 * 60 * 1_000_000);
  });
});
