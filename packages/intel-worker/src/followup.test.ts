import { describe, it, expect } from 'vitest';
import { FollowupAnswerSchema } from '@aizen/contracts';
import {
  LlmGateway,
  CostMeter,
  StubProvider,
  type LlmProvider,
  type CompletionRequest,
} from '@aizen/llm-gateway';
import type { WebSearchProvider } from '@aizen/research';
import { answerFollowup } from './explain.js';

/**
 * F1 follow-up engine (`answerFollowup`). Unlike `explainSentence`, a follow-up is
 * grounded in BOTH the conversation context AND web sources, and it must always
 * resolve — a stubbed/cost-capped gateway degrades gracefully rather than throwing.
 */

/** Records every prompt it sees and returns a fixed JSON answer. */
class CapturingProvider implements LlmProvider {
  readonly prompts: string[] = [];
  constructor(private readonly answer: string) {}
  async complete(req: CompletionRequest) {
    this.prompts.push(req.prompt);
    return { text: `{"answer":${JSON.stringify(this.answer)}}`, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

const meter = () => new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 4 });

const research: WebSearchProvider = {
  search: async (query) => ({
    query,
    sources: [
      { title: 'Investopedia', url: 'https://x/arr', snippet: 'ARR is annual recurring revenue.', score: 0.9 },
    ],
  }),
};

const baseInput = {
  segment_id: 'sess:seg:7',
  session_id: '11111111-1111-1111-1111-111111111111',
  tenant_id: '22222222-2222-2222-2222-222222222222',
  question: 'What did he mean by that?',
  context: {
    sentence: 'We will double ARR by Q4.',
    transcript: ['Welcome to the call.', 'We will double ARR by Q4.'],
  },
};

describe('answerFollowup (F1 follow-up engine)', () => {
  it('grounds the answer in conversation context + web sources and attaches citations', async () => {
    const provider = new CapturingProvider('He means the company plans to double annual recurring revenue by Q4.');
    const out = await answerFollowup(baseInput, new LlmGateway(provider, meter()), { research });

    expect(() => FollowupAnswerSchema.parse(out)).not.toThrow();
    expect(out.state).toBe('ok');
    expect(out.answer).toContain('recurring revenue');
    // The prompt fed to the model must carry BOTH the transcript context and the
    // web source — that's the whole point of a follow-up over a bare explain.
    const prompt = provider.prompts[0]!;
    expect(prompt).toContain('We will double ARR by Q4.');
    expect(prompt).toContain('Welcome to the call.');
    expect(prompt).toContain('ARR is annual recurring revenue.');
    // Web sources surface as web citations (INV-1/2).
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({ type: 'web', url: 'https://x/arr' });
  });

  it('answers a context-dependent question with NO research, from conversation context alone', async () => {
    const provider = new CapturingProvider('He meant they aim to double their annual recurring revenue.');
    const out = await answerFollowup(baseInput, new LlmGateway(provider, meter())); // no research

    expect(out.state).toBe('ok');
    expect(out.answer).toContain('double'); // a real answer, not null
    expect(out.sources).toHaveLength(0);
    expect(provider.prompts[0]).toContain('(no web sources available)');
  });

  it('degrades safely (state:degraded, answer:null) when the gateway is stubbed', async () => {
    const stubGw = new LlmGateway(new StubProvider(), meter());
    const out = await answerFollowup(baseInput, stubGw, { research });

    expect(() => FollowupAnswerSchema.parse(out)).not.toThrow();
    expect(out.state).toBe('degraded'); // stub's non-JSON reply is not a real answer
    expect(out.answer).toBeNull();
  });

  it('respects the cost ceiling: no provider call, degrades when the tenant is capped', async () => {
    const provider = new CapturingProvider('should never be produced');
    // ceiling 0 ⇒ the gateway refuses before ever calling the provider.
    const cappedGw = new LlmGateway(provider, new CostMeter({ tenantCeilingUsd: 0, opusCallCap: 4 }));
    const out = await answerFollowup(baseInput, cappedGw, { research });

    expect(provider.prompts).toHaveLength(0); // guardrail short-circuited the LLM hop
    expect(out.state).toBe('degraded');
    expect(out.answer).toBeNull();
  });

  it('suppresses an "unknown" answer but keeps the sources as leads', async () => {
    const unknownGw = new LlmGateway(new CapturingProvider('unknown'), meter());
    const out = await answerFollowup(baseInput, unknownGw, { research });

    expect(out.answer).toBeNull();
    expect(out.sources).toHaveLength(1);
    expect(out.state).toBe('ok');
  });

  it('grounds a follow-up in a user source with NO research, citing type:user', async () => {
    const provider = new CapturingProvider('Per your brief, the launch is set for Q4.');
    const userSources = [{ id: 'u1', title: 'Launch brief', text: 'The launch is set for Q4.' }];
    const out = await answerFollowup(baseInput, new LlmGateway(provider, meter()), { userSources }); // no research

    expect(() => FollowupAnswerSchema.parse(out)).not.toThrow();
    expect(out.state).toBe('ok');
    expect(out.answer).toContain('Q4');
    // a type:'user' citation (no url provided → no link), and the prompt carried it.
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({ type: 'user' });
    expect(out.sources[0]!.url).toBeUndefined();
    expect(provider.prompts[0]).toContain('Provided by the user');
    expect(provider.prompts[0]).toContain('The launch is set for Q4.');
  });

  it('blends web + user sources on a follow-up (web first, then user)', async () => {
    const provider = new CapturingProvider('ARR is annual recurring revenue; your note adds context.');
    const out = await answerFollowup(baseInput, new LlmGateway(provider, meter()), {
      research,
      userSources: [{ id: 'u1', url: 'https://notes/arr', text: 'Our ARR target is $10M.' }],
    });
    expect(out.sources).toHaveLength(2);
    expect(out.sources[0]).toMatchObject({ type: 'web', url: 'https://x/arr' });
    expect(out.sources[1]).toMatchObject({ type: 'user', url: 'https://notes/arr' });
  });

  it('never throws even when the research provider rejects', async () => {
    const flakyResearch: WebSearchProvider = {
      search: async () => {
        throw new Error('tavily down');
      },
    };
    const out = await answerFollowup(
      baseInput,
      new LlmGateway(new CapturingProvider('Answered from context only.'), meter()),
      { research: flakyResearch },
    );
    expect(out.sources).toHaveLength(0); // search failure swallowed
    expect(out.answer).toContain('context'); // still answered from conversation context
    expect(out.state).toBe('ok');
  });
});
