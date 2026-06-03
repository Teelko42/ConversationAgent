/**
 * Real Anthropic provider behind `LlmProvider` (P2, MAN-F02-005). This is the
 * BD-03 swap-in for `StubProvider`: same interface, real network. The gateway,
 * cost meter, tier routing, and D17 gate are all unchanged — only the bytes that
 * come back are real.
 *
 * Tier → model (D04): haiku = route/extract/verify, sonnet = the hot enrich
 * path, opus = on-demand deep dive. The model ids are overridable so a newer
 * snapshot can be pinned without code changes.
 *
 * Prompt caching (doc 11 cost lever): the (large, stable) system preamble is sent
 * as a cache-control block so repeated calls in a session read it at 0.1× input.
 * Usage is mapped back into `TokenUsage` so `CostMeter` accounts cache reads.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  Tier,
  TokenUsage,
} from './index.js';

/** Default model ids per tier (latest Claude 4.x family). Overridable. */
export const DEFAULT_MODELS: Record<Tier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
};

/** Default per-tier output ceiling; a request's est can lift it. */
const DEFAULT_MAX_TOKENS: Record<Tier, number> = {
  haiku: 512,
  sonnet: 1024,
  opus: 4096,
};

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Override any/all tier→model ids (e.g. pin a newer snapshot). */
  models?: Partial<Record<Tier, string>>;
  /** Stable system preamble; sent as a cache-control block (0.1× on re-read). */
  system?: string;
  /** Injectable client (tests). Defaults to a real `Anthropic` from the key. */
  client?: Pick<Anthropic, 'messages'>;
  /**
   * Per-request timeout (ms). The SDK default is ~10 minutes — effectively
   * "forever" for a live UI — so we bound it so a wedged model call surfaces as a
   * normal error (the gateway degrades) instead of an endless spinner. Default 25s.
   */
  requestTimeoutMs?: number;
}

/** The default system preamble — Aizen's role, kept stable so it caches well. */
const DEFAULT_SYSTEM =
  'You are Aizen, a real-time conversation-intelligence engine. You explain ' +
  'concepts, acronyms, and entities that appear in a live transcript. Be ' +
  'accurate and concise. Ground every claim in the supplied transcript or ' +
  'sources; never invent facts. When unsure, say so.';

export class AnthropicProvider implements LlmProvider {
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly models: Record<Tier, string>;
  private readonly system: string;
  private readonly requestTimeoutMs: number;

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.apiKey && !opts.client) {
      throw new Error('AnthropicProvider: apiKey (or an injected client) is required');
    }
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.models = { ...DEFAULT_MODELS, ...opts.models };
    this.system = opts.system ?? DEFAULT_SYSTEM;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 25000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = this.models[req.tier];
    const max_tokens = Math.max(
      req.estOutputTokens ?? 0,
      DEFAULT_MAX_TOKENS[req.tier],
    );

    const msg = await this.client.messages.create(
      {
        model,
        max_tokens,
        // cache the stable preamble so re-reads bill at 0.1× input (doc 11).
        system: [
          { type: 'text', text: this.system, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: req.prompt }],
      },
      // Bound the call + cap retries so a wedged/overloaded request can't hang the
      // live UI (SDK default is ~10 min with 2 retries).
      { timeout: this.requestTimeoutMs, maxRetries: 1 },
    );

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return { text, usage: mapUsage(msg.usage) };
  }
}

/**
 * Map Anthropic usage → our `TokenUsage`. Anthropic reports fresh input, cache
 * reads, and cache creation separately; `costUsd` wants total `inputTokens` with
 * `cachedInputTokens` carved out for the 0.1× rate, so we sum them and pass the
 * read count through. Cache *creation* is billed as fresh input here (a small
 * over-estimate vs Anthropic's 1.25×, acceptable for the Phase-1 cost model).
 */
function mapUsage(u: Anthropic.Usage): TokenUsage {
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens + cacheRead + cacheCreate,
    outputTokens: u.output_tokens,
    cachedInputTokens: cacheRead,
  };
}
