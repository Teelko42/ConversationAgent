import { describe, it, expect } from 'vitest';
import {
  routeTier,
  clampTier,
  shouldSpeculativelyExtract,
  costUsd,
  CostMeter,
  LlmGateway,
  StubProvider,
  DEFAULT_GATE,
} from './index.js';

describe('LLM gateway — routing (D04)', () => {
  it('routes tasks to the right tier', () => {
    expect(routeTier('extract')).toBe('haiku');
    expect(routeTier('verify')).toBe('haiku');
    expect(routeTier('enrich')).toBe('sonnet');
    expect(routeTier('deep')).toBe('opus');
  });
  it('clamps to a tenant tier cap (Free = Haiku-only)', () => {
    expect(clampTier('opus', 'haiku')).toBe('haiku');
    expect(clampTier('sonnet', 'haiku')).toBe('haiku');
    expect(clampTier('haiku', undefined)).toBe('haiku');
    expect(clampTier('sonnet', 'sonnet')).toBe('sonnet');
  });
});

describe('D17 salience/stability gate (shared latency+cost control)', () => {
  it('acts only on stable, salient, high-confidence (or domain-term) partials', () => {
    const base = { stableMs: 350, confidenceBand: 'high' as const, isDomainTerm: false, salience: 0.8 };
    expect(shouldSpeculativelyExtract(base)).toBe(true);
    expect(shouldSpeculativelyExtract({ ...base, stableMs: 100 })).toBe(false); // not stable
    expect(shouldSpeculativelyExtract({ ...base, salience: 0.2 })).toBe(false); // not salient
    expect(
      shouldSpeculativelyExtract({ ...base, confidenceBand: 'low', isDomainTerm: false }),
    ).toBe(false); // low conf, not a domain term
    expect(
      shouldSpeculativelyExtract({ ...base, confidenceBand: 'low', isDomainTerm: true }),
    ).toBe(true); // domain term rescues low band
  });
  it('exposes the doc-12 default (300ms hysteresis)', () => {
    expect(DEFAULT_GATE.minStableMs).toBe(300);
  });
});

describe('cost accounting (doc 11 §0 rate card)', () => {
  it('computes Sonnet cost with cache reads at 0.1× input', () => {
    // 3000 cached + 400 fresh in + 400 out  (the doc 11 §1.1 worked example)
    const c = costUsd('sonnet', { inputTokens: 3400, outputTokens: 400, cachedInputTokens: 3000 });
    // (3000*3*0.1 + 400*3 + 400*15) / 1e6 = (900 + 1200 + 6000)/1e6 = 0.0081
    expect(c).toBeCloseTo(0.0081, 6);
  });
});

describe('cost ceilings (D15 + doc 11 §1.2 Opus cap)', () => {
  it('blocks Opus past the escalation cap', () => {
    const meter = new CostMeter({ tenantCeilingUsd: 1000, opusCallCap: 2 });
    meter.record('opus', { inputTokens: 1, outputTokens: 1 });
    meter.record('opus', { inputTokens: 1, outputTokens: 1 });
    expect(meter.canInvoke('opus').ok).toBe(false);
    expect(meter.canInvoke('opus').reason).toBe('opus_escalation_cap');
    expect(meter.canInvoke('sonnet').ok).toBe(true); // other tiers unaffected
  });
  it('blocks all tiers once the tenant cost ceiling is hit', () => {
    const meter = new CostMeter({ tenantCeilingUsd: 0.000001, opusCallCap: 99 });
    meter.record('sonnet', { inputTokens: 1000, outputTokens: 1000 });
    expect(meter.canInvoke('haiku').ok).toBe(false);
    expect(meter.canInvoke('haiku').reason).toBe('tenant_cost_ceiling');
  });
});

describe('gateway end-to-end (stub provider)', () => {
  it('Free tenant is forced to Haiku regardless of task', async () => {
    const gw = new LlmGateway(new StubProvider(), new CostMeter({ tenantCeilingUsd: 100, opusCallCap: 10 }));
    const r = await gw.invoke({ kind: 'deep', tenantId: 't', prompt: 'explain RAG', tierCap: 'haiku' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tier).toBe('haiku');
  });
  it('returns a degraded result when a ceiling is hit (not an exception)', async () => {
    const gw = new LlmGateway(new StubProvider(), new CostMeter({ tenantCeilingUsd: 0, opusCallCap: 0 }));
    const r = await gw.invoke({ kind: 'enrich', tenantId: 't', prompt: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tenant_cost_ceiling');
  });
});
