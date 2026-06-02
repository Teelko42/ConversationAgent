import { describe, it, expect } from 'vitest';
import { makeConceptCard } from '@aizen/contracts';
import { LlmGateway, CostMeter, type LlmProvider } from '@aizen/llm-gateway';
import type { WebSearchProvider } from '@aizen/research';
import { enrichCard } from './enrich.js';

/** Gateway provider that returns a JSON enrichment, as the real model is asked to. */
class JsonProvider implements LlmProvider {
  async complete() {
    return {
      text: '{"canonical_name":"Annual Recurring Revenue","definition":"Yearly subscription revenue."}',
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

const gateway = () =>
  new LlmGateway(new JsonProvider(), new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 }));

const research: WebSearchProvider = {
  search: async (query) => ({
    query,
    answer: 'arr',
    sources: [{ title: 'Investopedia', url: 'https://x/arr', snippet: 'arr def', score: 0.9 }],
  }),
};

function skeleton() {
  return makeConceptCard({
    state: 'skeleton',
    canonical_name: 'ARR',
    sources: [
      { citation_id: 'ct', type: 'transcript', transcript_segment_ids: ['seg'], snippet: 'quarterly ARR' },
    ],
    grounding: undefined,
  });
}

describe('enrichCard (P2 explain engine)', () => {
  it('produces an enriched revision with a grounded definition + web citation', async () => {
    const card = skeleton();
    const out = await enrichCard(card, gateway(), { research });

    expect(out.state).toBe('enriched');
    expect(out.revision).toBe(card.revision + 1);
    expect(out.canonical_name).toBe('Annual Recurring Revenue');
    expect(out.definition_short).toContain('subscription');
    expect(out.sources.some((s) => s.type === 'web' && s.url === 'https://x/arr')).toBe(true);
    expect(out.grounding?.grounded).toBe(true);
  });

  it('still enriches (transcript-only) when no research provider is given', async () => {
    const out = await enrichCard(skeleton(), gateway());
    expect(out.state).toBe('enriched');
    expect(out.sources.some((s) => s.type === 'web')).toBe(false);
    expect(out.grounding?.grounded).toBe(false);
  });

  it('keeps the skeleton when the gateway degrades (cost ceiling)', async () => {
    // a meter already at its ceiling forces a degraded invoke result.
    const gw = new LlmGateway(new JsonProvider(), new CostMeter({ tenantCeilingUsd: 0, opusCallCap: 0 }));
    const card = skeleton();
    const out = await enrichCard(card, gw, { research });
    expect(out.state).toBe('skeleton');
    expect(out.revision).toBe(card.revision);
  });
});
