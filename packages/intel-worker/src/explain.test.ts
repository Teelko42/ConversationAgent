import { describe, it, expect } from 'vitest';
import { SentenceExplanationSchema } from '@aizen/contracts';
import { LlmGateway, CostMeter, StubProvider, type LlmProvider, type CompletionRequest } from '@aizen/llm-gateway';
import type { WebSearchProvider } from '@aizen/research';
import { explainSentence, looksLikeQuestion, pickKeyWords } from './explain.js';

/**
 * Provider that answers the explain call with JSON, and (when it sees the answer
 * prompt) the grounded-answer call with JSON. Branches on a marker in the prompt.
 */
class ScriptedProvider implements LlmProvider {
  async complete(req: CompletionRequest) {
    const text = req.prompt.includes('Use ONLY these web sources')
      ? '{"answer":"Paris is the capital of France."}'
      : '{"explanation":"It asks for the capital city of France.",' +
        '"breakdown":[{"word":"capital","meaning":"the seat of government"}],' +
        '"is_question":true,"search_query":"capital of France"}';
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

const gateway = () =>
  new LlmGateway(new ScriptedProvider(), new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 }));

const research: WebSearchProvider = {
  search: async (query) => ({
    query,
    sources: [{ title: 'Britannica', url: 'https://x/paris', snippet: 'Paris, capital of France.', score: 0.9 }],
  }),
};

const input = {
  segment_id: 'sess:seg:1',
  session_id: '11111111-1111-1111-1111-111111111111',
  tenant_id: '22222222-2222-2222-2222-222222222222',
  text: 'What is the capital of France?',
};

describe('explainSentence (P2 sentence explain engine)', () => {
  it('returns a schema-valid explanation with a word breakdown', async () => {
    const out = await explainSentence(input, gateway(), { research });
    expect(() => SentenceExplanationSchema.parse(out)).not.toThrow();
    expect(out.state).toBe('ok');
    expect(out.explanation).toContain('France');
    expect(out.breakdown[0]).toEqual({ word: 'capital', meaning: 'the seat of government' });
  });

  it('answers a question grounded in web sources, attaching web citations', async () => {
    const out = await explainSentence(input, gateway(), { research });
    expect(out.is_question).toBe(true);
    expect(out.answer).toContain('Paris');
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({ type: 'web', url: 'https://x/paris' });
  });

  it('does not answer a question when no research provider is wired', async () => {
    const out = await explainSentence(input, gateway());
    expect(out.is_question).toBe(true);
    expect(out.answer).toBeNull();
    expect(out.sources).toHaveLength(0);
  });

  it('degrades to a heuristic breakdown when the model returns non-JSON (stub mode)', async () => {
    const stubGw = new LlmGateway(new StubProvider(), new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 }));
    const out = await explainSentence(
      { ...input, text: 'The acquisition will affect quarterly EBITDA significantly.' },
      stubGw,
    );
    expect(() => SentenceExplanationSchema.parse(out)).not.toThrow();
    expect(out.state).toBe('degraded');
    expect(out.breakdown.map((b) => b.word)).toContain('acquisition');
    expect(out.breakdown.map((b) => b.word)).toContain('EBITDA');
  });

  it('suppresses an unanswerable question answer (sources lack it → "unknown")', async () => {
    const unknownGw = new LlmGateway(
      {
        complete: async (req: CompletionRequest) => ({
          text: req.prompt.includes('Use ONLY these web sources')
            ? '{"answer":"unknown"}'
            : '{"explanation":"x","breakdown":[],"is_question":true,"search_query":"q"}',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
      new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 }),
    );
    const out = await explainSentence(input, unknownGw, { research });
    expect(out.answer).toBeNull();
    expect(out.sources).toHaveLength(1); // sources kept as leads even when unanswerable
  });
});

describe('explain heuristics', () => {
  it('looksLikeQuestion detects "?" and leading interrogatives', () => {
    expect(looksLikeQuestion('How does this work')).toBe(true);
    expect(looksLikeQuestion('This works.')).toBe(false);
    expect(looksLikeQuestion('Really?')).toBe(true);
  });

  it('pickKeyWords selects acronyms and long words, skipping stopwords', () => {
    const words = pickKeyWords('We discussed the acquisition and the EBITDA between teams.');
    expect(words).toContain('acquisition');
    expect(words).toContain('EBITDA');
    expect(words).not.toContain('the');
    expect(words).not.toContain('between');
  });
});
