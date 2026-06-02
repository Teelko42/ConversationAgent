import { describe, it, expect } from 'vitest';
import { AnthropicProvider, DEFAULT_MODELS } from './index.js';

/** A fake Anthropic `messages` surface that records the request and replies. */
function fakeClient(capture: { req?: unknown }) {
  return {
    messages: {
      create: async (req: unknown) => {
        capture.req = req;
        return {
          content: [{ type: 'text', text: 'an explanation' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 5,
          },
        };
      },
    },
  };
}

describe('AnthropicProvider (real LlmProvider swap-in)', () => {
  it('maps each tier to its model id and returns the text', async () => {
    const cap: { req?: { model?: string } } = {};
    const p = new AnthropicProvider({ apiKey: 'x', client: fakeClient(cap) as never });

    const res = await p.complete({ tier: 'sonnet', prompt: 'what is ARR?' });
    expect(res.text).toBe('an explanation');
    expect(cap.req?.model).toBe(DEFAULT_MODELS.sonnet);

    await p.complete({ tier: 'haiku', prompt: 'x' });
    expect(cap.req?.model).toBe(DEFAULT_MODELS.haiku);
  });

  it('sends a cache-controlled system block (doc 11 cost lever)', async () => {
    const cap: { req?: { system?: Array<{ cache_control?: unknown }> } } = {};
    const p = new AnthropicProvider({ apiKey: 'x', client: fakeClient(cap) as never });
    await p.complete({ tier: 'haiku', prompt: 'x' });
    expect(Array.isArray(cap.req?.system)).toBe(true);
    expect(cap.req?.system?.[0]?.cache_control).toBeTruthy();
  });

  it('maps usage so CostMeter accounts cache reads', async () => {
    const cap: { req?: unknown } = {};
    const p = new AnthropicProvider({ apiKey: 'x', client: fakeClient(cap) as never });
    const res = await p.complete({ tier: 'haiku', prompt: 'x' });
    // inputTokens = fresh(100) + cacheRead(30) + cacheCreate(5)
    expect(res.usage.inputTokens).toBe(135);
    expect(res.usage.cachedInputTokens).toBe(30);
    expect(res.usage.outputTokens).toBe(20);
  });

  it('requires a key or an injected client', () => {
    expect(() => new AnthropicProvider({ apiKey: '' })).toThrow();
  });
});
