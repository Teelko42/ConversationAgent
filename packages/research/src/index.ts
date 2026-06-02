/**
 * @aizen/research — P2-C (lite) sourced-background retrieval. The vendor-neutral
 * `WebSearchProvider` is the seam (BD-03); `TavilyWebSearchProvider` is the
 * default real adapter (.env `WEB_SEARCH_PROVIDER=tavily`), and
 * `NullWebSearchProvider` is the no-key fallback so callers can always invoke a
 * provider without branching.
 *
 * Output is shaped toward F02 grounding: each result row becomes a `WebSource`
 * the enrich path turns into a `type:'web'` Citation on a ConceptCard (INV-1/2 —
 * web claims must carry a URL + snippet so F03 can show provenance).
 */

/** One retrieved web source, ready to become a `type:'web'` Citation. */
export interface WebSource {
  title: string;
  url: string;
  snippet: string;
  /** provider relevance score (0..1) when available. */
  score?: number;
}

/** A search response: an optional synthesized answer plus ranked sources. */
export interface WebSearchResult {
  query: string;
  answer?: string;
  sources: WebSource[];
}

export interface WebSearchOptions {
  maxResults?: number;
}

/** Vendor-neutral web search. Real adapters (Tavily/Brave) implement this. */
export interface WebSearchProvider {
  search(query: string, opts?: WebSearchOptions): Promise<WebSearchResult>;
}

/** No-op provider: used when no search key is configured. Always empty. */
export class NullWebSearchProvider implements WebSearchProvider {
  async search(query: string): Promise<WebSearchResult> {
    return { query, sources: [] };
  }
}

export interface TavilyProviderOptions {
  apiKey: string;
  /** Override endpoint (default Tavily search API). */
  endpoint?: string;
  /** 'basic' (fast/cheap) or 'advanced' (deeper). Default 'basic'. */
  searchDepth?: 'basic' | 'advanced';
  /** Inject a fetch (tests). Defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

/** Shape of the bits of the Tavily response we consume. */
interface TavilyResponse {
  answer?: string;
  results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
}

/**
 * Tavily adapter (tavily.com). POSTs the query with a Bearer key and maps the
 * `results[]` into `WebSource`s. Errors are surfaced (the enrich path catches and
 * degrades to transcript-only grounding rather than failing the card).
 */
export class TavilyWebSearchProvider implements WebSearchProvider {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TavilyProviderOptions) {
    if (!opts.apiKey) throw new Error('TavilyWebSearchProvider: apiKey is required');
    this.endpoint = opts.endpoint ?? 'https://api.tavily.com/search';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string, opts: WebSearchOptions = {}): Promise<WebSearchResult> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: opts.maxResults ?? 4,
        search_depth: this.opts.searchDepth ?? 'basic',
        include_answer: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`tavily search failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as TavilyResponse;
    const sources: WebSource[] = (data.results ?? []).map((r) => ({
      title: r.title ?? r.url ?? 'source',
      url: r.url ?? '',
      snippet: r.content ?? '',
      score: r.score,
    }));
    return { query, answer: data.answer, sources };
  }
}

/**
 * Build the configured provider from environment-style settings. Returns the
 * `NullWebSearchProvider` when no usable key is present, so the caller never has
 * to special-case "search disabled".
 */
export function makeWebSearchProvider(cfg: {
  provider?: string;
  tavilyApiKey?: string;
}): WebSearchProvider {
  const provider = (cfg.provider ?? 'tavily').toLowerCase();
  if (provider === 'tavily' && cfg.tavilyApiKey) {
    return new TavilyWebSearchProvider({ apiKey: cfg.tavilyApiKey });
  }
  return new NullWebSearchProvider();
}
