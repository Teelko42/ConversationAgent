import { describe, it, expect } from 'vitest';
import {
  TavilyWebSearchProvider,
  NullWebSearchProvider,
  makeWebSearchProvider,
} from './index.js';

describe('TavilyWebSearchProvider', () => {
  it('maps the Tavily response into WebSources', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        answer: 'ARR is annual recurring revenue.',
        results: [
          { title: 'Investopedia', url: 'https://x/arr', content: 'ARR definition', score: 0.9 },
        ],
      }),
    })) as unknown as typeof fetch;

    const p = new TavilyWebSearchProvider({ apiKey: 'k', fetchImpl: fakeFetch });
    const r = await p.search('ARR');
    expect(r.answer).toContain('annual recurring revenue');
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]!.url).toBe('https://x/arr');
    expect(r.sources[0]!.score).toBe(0.9);
  });

  it('throws on a non-ok response', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    })) as unknown as typeof fetch;
    const p = new TavilyWebSearchProvider({ apiKey: 'k', fetchImpl: fakeFetch });
    await expect(p.search('x')).rejects.toThrow(/401/);
  });

  it('aborts (does not hang) when the request exceeds the timeout', async () => {
    // A fetch that never resolves on its own — only the AbortController can end it.
    // Without the timeout this await would hang forever (the real "Answering…"
    // forever bug); with it, the request is aborted and the promise rejects.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;

    const p = new TavilyWebSearchProvider({ apiKey: 'k', fetchImpl: hangingFetch, timeoutMs: 20 });
    await expect(p.search('x')).rejects.toThrow();
  });
});

describe('makeWebSearchProvider', () => {
  it('returns Null provider when no key is configured', () => {
    expect(makeWebSearchProvider({ provider: 'tavily' })).toBeInstanceOf(NullWebSearchProvider);
  });
  it('returns Tavily when a key is present', () => {
    expect(
      makeWebSearchProvider({ provider: 'tavily', tavilyApiKey: 'k' }),
    ).toBeInstanceOf(TavilyWebSearchProvider);
  });
});
