import { describe, it, expect } from 'vitest';
import { SentenceExplanationSchema } from '@aizen/contracts';
import { LlmGateway, CostMeter, StubProvider, type LlmProvider, type CompletionRequest } from '@aizen/llm-gateway';
import type { WebSearchProvider } from '@aizen/research';
import { explainSentence, looksLikeQuestion, pickKeyWords } from './explain.js';

/**
 * Provider that answers the explain call with JSON (structured breakdown), and the
 * grounded-answer call with PLAIN TEXT (the answer streams, so it is no longer JSON).
 * Branches on a marker in the prompt.
 */
class ScriptedProvider implements LlmProvider {
  async complete(req: CompletionRequest) {
    const text = req.prompt.includes('Use ONLY these web sources')
      ? 'Paris is the capital of France.'
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
            ? 'unknown'
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

/**
 * Branches like ScriptedProvider, but the "answer" hop returns a fixed reply for
 * ANY answer prompt (web-only or user-grounded) — it keys on the explain prompt's
 * `"breakdown"` marker, not on the web-only "Use ONLY these web sources" phrase.
 */
class UserGroundedProvider implements LlmProvider {
  readonly prompts: string[] = [];
  async complete(req: CompletionRequest) {
    this.prompts.push(req.prompt);
    const text = req.prompt.includes('"breakdown"')
      ? '{"explanation":"asks when Project X ships","breakdown":[],"is_question":true,"search_query":"project x ship date"}'
      : 'Project X ships in Q4 per the brief.'; // plain-text answer (streams)
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

describe('explainSentence with user-provided sources (F2 — BYO sources)', () => {
  it('answers a question from a user source with NO research provider, citing type:user', async () => {
    const provider = new UserGroundedProvider();
    const userSources = [
      { id: 'u1', title: 'Q4 brief', text: 'Project X ships in Q4.' },
    ];
    const out = await explainSentence(
      { ...input, text: 'When does Project X ship?' },
      new LlmGateway(provider, new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 })),
      { userSources }, // NO research — the user source alone grounds the answer
    );

    expect(() => SentenceExplanationSchema.parse(out)).not.toThrow();
    expect(out.is_question).toBe(true);
    expect(out.answer).toContain('Q4');
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({ type: 'user' });
    expect(out.sources[0]!.url).toBeUndefined(); // no url provided → no link
    // the answer prompt carried the user block verbatim.
    const answerPrompt = provider.prompts.find(
      (p) => p.includes('Answer in plain text') && !p.includes('"breakdown"'),
    )!;
    expect(answerPrompt).toContain('Provided by the user');
    expect(answerPrompt).toContain('Project X ships in Q4.');
  });

  it('blends web + user sources when both are present (web first, then user)', async () => {
    const out = await explainSentence(input, gateway(), {
      research,
      userSources: [{ id: 'u1', url: 'https://notes/paris', text: 'We toured Paris last spring.' }],
    });
    expect(out.sources).toHaveLength(2);
    expect(out.sources[0]).toMatchObject({ type: 'web' });
    expect(out.sources[1]).toMatchObject({ type: 'user', url: 'https://notes/paris' });
  });

  it('carries source provenance onto the citation type (F3 §4: file / obsidian / user)', async () => {
    // A file-derived source (origin:'file') cites as type:'file'; an Obsidian note
    // (origin:'obsidian') as type:'obsidian'; a plain paste / no origin as 'user'.
    const out = await explainSentence(
      { ...input, text: 'When does Project X ship?' },
      new LlmGateway(new UserGroundedProvider(), new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 })),
      {
        userSources: [
          { id: 'f1', origin: 'file', title: 'brief.md', text: 'Project X ships in Q4.' },
          { id: 'o1', origin: 'obsidian', title: 'notes/x.md', text: 'X ships alongside the Q4 launch.' },
          { id: 'p1', text: 'A pasted note with no origin.' },
        ],
      },
    );
    expect(() => SentenceExplanationSchema.parse(out)).not.toThrow();
    expect(out.sources).toHaveLength(3);
    expect(out.sources[0]).toMatchObject({ type: 'file', title: 'brief.md' });
    expect(out.sources[1]).toMatchObject({ type: 'obsidian', title: 'notes/x.md' });
    expect(out.sources[2]).toMatchObject({ type: 'user' });
  });

  it('grounds the EXPLANATION step in connected sources, not only the answer', async () => {
    // The explanation prompt (the first hop) must fold in the user's notes so the
    // meaning itself reflects their vault — and stay byte-for-byte unchanged when
    // there are none.
    const withSrc = new UserGroundedProvider();
    await explainSentence(
      { ...input, text: 'What is Zephyr?' },
      new LlmGateway(withSrc, new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 })),
      { userSources: [{ id: 'o', origin: 'obsidian', title: 'notes/zephyr.md', text: 'Zephyr is our mobile app codename.' }] },
    );
    const explainPrompt = withSrc.prompts.find((p) => p.includes('"breakdown"'))!;
    expect(explainPrompt).toContain('connected their own notes');
    expect(explainPrompt).toContain('Zephyr is our mobile app codename.');

    const noSrc = new UserGroundedProvider();
    await explainSentence(
      { ...input, text: 'What is Zephyr?' },
      new LlmGateway(noSrc, new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 })),
    );
    const plainPrompt = noSrc.prompts.find((p) => p.includes('"breakdown"'))!;
    expect(plainPrompt).not.toContain('connected their own notes');
  });
});

describe('explainSentence with live transcript context (split-by-pause)', () => {
  it('folds the surrounding transcript into BOTH the explain and answer prompts', async () => {
    const provider = new UserGroundedProvider();
    const out = await explainSentence(
      { ...input, text: 'What did they report?' }, // a fragment split from its setup line
      new LlmGateway(provider, new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 })),
      { research, transcript: ['Turning to revenue for the quarter.', 'What did they report?'] },
    );
    expect(() => SentenceExplanationSchema.parse(out)).not.toThrow();

    // Hop 1 (explain/breakdown/classify) sees the neighbouring line for context…
    const explainPrompt = provider.prompts.find((p) => p.includes('"breakdown"'))!;
    expect(explainPrompt).toContain('Recent conversation for context');
    expect(explainPrompt).toContain('Turning to revenue for the quarter.');

    // …and so does the grounded-answer hop (to resolve what the question refers to).
    const answerPrompt = provider.prompts.find(
      (p) => p.includes('Answer in plain text') && !p.includes('"breakdown"'),
    )!;
    expect(answerPrompt).toContain('Recent conversation for context');
    expect(answerPrompt).toContain('Turning to revenue for the quarter.');
    // The answer is still grounded ONLY in the sources, not the transcript.
    expect(answerPrompt).toContain('not as a source for the answer');
  });

  it('leaves both prompts byte-for-byte unchanged when no transcript is supplied', async () => {
    const provider = new UserGroundedProvider();
    await explainSentence(
      { ...input, text: 'What did they report?' },
      new LlmGateway(provider, new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 })),
      { research }, // no transcript
    );
    for (const p of provider.prompts) expect(p).not.toContain('Recent conversation for context');
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
