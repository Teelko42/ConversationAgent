/**
 * D15 LLM gateway (skeleton). F04 owns this; F02/F03 consume it and never call
 * providers directly. It encodes three things the design depends on:
 *  - D04 tier routing (Haiku route/extract/verify, Sonnet enrich, Opus deep).
 *  - doc 11 cost accounting + per-tenant ceilings + the Opus escalation cap.
 *  - D17 salience/stability gate — the SHARED control point for latency AND cost.
 *
 * Providers are stubbed; real Anthropic calls need the account (MAN-F02-005).
 */

export type Tier = 'haiku' | 'sonnet' | 'opus';
export type TaskKind =
  | 'route'
  | 'classify'
  | 'extract'
  | 'enrich'
  | 'deep'
  | 'verify'
  | 'summarize';

const TIER_ORDER: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 };

/** D04 — map a task to its model tier. */
export function routeTier(kind: TaskKind): Tier {
  switch (kind) {
    case 'enrich':
      return 'sonnet'; // the real-time hot explanation path
    case 'deep':
      return 'opus'; // deep dive, on demand
    default:
      return 'haiku'; // route/classify/extract/verify/summarize
  }
}

/** Clamp to a per-tenant ceiling tier (e.g. Free = Haiku-only, D15/F05). */
export function clampTier(routed: Tier, cap: Tier | undefined): Tier {
  if (!cap) return routed;
  return TIER_ORDER[routed] <= TIER_ORDER[cap] ? routed : cap;
}

// ---------------------------------------------------------------------------
// D17 salience/stability gate — shared latency+cost control (doc 12 §4)
// ---------------------------------------------------------------------------
export interface PartialSignal {
  /** how long this partial's tokens have been unchanged (hysteresis). */
  stableMs: number;
  confidenceBand: 'high' | 'medium' | 'low';
  isDomainTerm: boolean;
  salience: number; // 0..1
}
export interface GateConfig {
  minStableMs: number; // e.g. 300 (doc 12 §4.1)
  minSalience: number;
}
export const DEFAULT_GATE: GateConfig = { minStableMs: 300, minSalience: 0.5 };

/**
 * Decide whether to SPECULATIVELY extract/enrich on a partial (D17). Bounding
 * this bounds both perceived latency and the `enrichments/min` cost lever
 * (doc 11 §1.2) — tune once, against both budgets.
 */
export function shouldSpeculativelyExtract(
  sig: PartialSignal,
  cfg: GateConfig = DEFAULT_GATE,
): boolean {
  if (sig.stableMs < cfg.minStableMs) return false;
  if (sig.salience < cfg.minSalience) return false;
  return sig.confidenceBand === 'high' || sig.isDomainTerm;
}

// ---------------------------------------------------------------------------
// Cost accounting + ceilings (doc 11 §0 rate card, §1.2 Opus cap)
// ---------------------------------------------------------------------------
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number; // billed at 0.1× input (cache read)
}
const RATES_PER_MTOK: Record<Tier, { in: number; out: number }> = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
  opus: { in: 15, out: 75 },
};
const CACHE_READ_MULTIPLIER = 0.1;

export function costUsd(tier: Tier, u: TokenUsage): number {
  const r = RATES_PER_MTOK[tier];
  const cached = u.cachedInputTokens ?? 0;
  const fresh = Math.max(0, u.inputTokens - cached);
  return (
    (cached * r.in * CACHE_READ_MULTIPLIER + fresh * r.in + u.outputTokens * r.out) / 1_000_000
  );
}

export interface CostMeterOptions {
  tenantCeilingUsd: number; // per-tenant cost-ceiling cutoff (D15)
  opusCallCap: number; // Opus escalations allowed in the window (doc 11 §1.2)
}
export class CostMeter {
  private spent = 0;
  private opusCalls = 0;
  constructor(private readonly opts: CostMeterOptions) {}

  spentUsd(): number {
    return this.spent;
  }

  /** May this tier be invoked now, given ceilings? */
  canInvoke(tier: Tier): { ok: boolean; reason?: string } {
    if (this.spent >= this.opts.tenantCeilingUsd) {
      return { ok: false, reason: 'tenant_cost_ceiling' };
    }
    if (tier === 'opus' && this.opusCalls >= this.opts.opusCallCap) {
      return { ok: false, reason: 'opus_escalation_cap' };
    }
    return { ok: true };
  }

  record(tier: Tier, u: TokenUsage): number {
    const c = costUsd(tier, u);
    this.spent += c;
    if (tier === 'opus') this.opusCalls += 1;
    return c;
  }
}

// ---------------------------------------------------------------------------
// Provider abstraction + stub (no network)
// ---------------------------------------------------------------------------
export interface CompletionRequest {
  tier: Tier;
  prompt: string;
  estInputTokens?: number;
  estOutputTokens?: number;
  cachedInputTokens?: number;
}
export interface CompletionResult {
  text: string;
  usage: TokenUsage;
}
/**
 * Callbacks for a STREAMED completion (the hot user-facing answer hop). A provider
 * that streams emits each text fragment via `onDelta` as it is produced, and may be
 * cancelled via `signal` (e.g. a speculative answer that turned out unwanted).
 */
export interface StreamHandlers {
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}
export interface LlmProvider {
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /**
   * Optional streaming variant. When present, the gateway prefers it for hot
   * user-facing text so tokens reach the browser as they are produced. A provider
   * WITHOUT it (e.g. the deterministic `StubProvider`) is still fully usable — the
   * gateway falls back to `complete()` and simply emits no deltas, so demo mode
   * never streams the stub's marker text to the UI.
   */
  completeStream?(req: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult>;
}

/** The deterministic stub's reply marker (see `StubProvider`). */
const STUB_REPLY_PREFIX = '[stub:';
/**
 * True when `text` is the `StubProvider`'s canned reply rather than a real model
 * answer. The hot answer path emits PLAIN TEXT (so it can stream token-by-token),
 * so it can no longer detect "no real model" by a failed JSON parse — it asks this
 * instead, and degrades (answer:null) when true. Deliberately NOT keyed on
 * "did the provider stream", so a real non-streaming provider still answers.
 */
export function isStubReply(text: string): boolean {
  return typeof text === 'string' && text.startsWith(STUB_REPLY_PREFIX);
}

export class StubProvider implements LlmProvider {
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    return {
      text: `${STUB_REPLY_PREFIX}${req.tier}] ${req.prompt.slice(0, 24)}`,
      usage: {
        inputTokens: req.estInputTokens ?? 100,
        outputTokens: req.estOutputTokens ?? 50,
        cachedInputTokens: req.cachedInputTokens ?? 0,
      },
    };
  }
  // Intentionally NO `completeStream` — the gateway falls back to `complete()` for
  // the stub, so demo mode degrades cleanly (no deltas, no marker text on screen).
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------
export interface InvokeTask {
  kind: TaskKind;
  tenantId: string;
  prompt: string;
  tierCap?: Tier; // e.g. Free tenant → 'haiku'
  estInputTokens?: number;
  estOutputTokens?: number;
  cachedInputTokens?: number;
}
export type InvokeResult =
  | { ok: true; tier: Tier; text: string; usage: TokenUsage; costUsd: number }
  | { ok: false; degraded: true; tier: Tier; reason: string };

export class LlmGateway {
  constructor(
    private readonly provider: LlmProvider,
    private readonly meter: CostMeter,
  ) {}

  async invoke(task: InvokeTask): Promise<InvokeResult> {
    const tier = clampTier(routeTier(task.kind), task.tierCap);
    const guard = this.meter.canInvoke(tier);
    if (!guard.ok) {
      return { ok: false, degraded: true, tier, reason: guard.reason! };
    }
    const res = await this.provider.complete({
      tier,
      prompt: task.prompt,
      estInputTokens: task.estInputTokens,
      estOutputTokens: task.estOutputTokens,
      cachedInputTokens: task.cachedInputTokens,
    });
    const cost = this.meter.record(tier, res.usage);
    return { ok: true, tier, text: res.text, usage: res.usage, costUsd: cost };
  }

  /**
   * Streaming sibling of `invoke`: same routing + cost ceilings, but the provider's
   * tokens are surfaced through `handlers.onDelta` as they arrive (the latency lever
   * — the browser renders the answer while it is still being written). Falls back to
   * a non-streaming `complete()` when the provider can't stream (the stub), emitting
   * no deltas. NEVER throws — an intentional abort or any provider error degrades to
   * `{ ok:false }`, so a half-streamed answer always has a clean terminal result.
   */
  async invokeStream(task: InvokeTask, handlers: StreamHandlers = {}): Promise<InvokeResult> {
    const tier = clampTier(routeTier(task.kind), task.tierCap);
    const guard = this.meter.canInvoke(tier);
    if (!guard.ok) {
      return { ok: false, degraded: true, tier, reason: guard.reason! };
    }
    const req: CompletionRequest = {
      tier,
      prompt: task.prompt,
      estInputTokens: task.estInputTokens,
      estOutputTokens: task.estOutputTokens,
      cachedInputTokens: task.cachedInputTokens,
    };
    try {
      const res = this.provider.completeStream
        ? await this.provider.completeStream(req, handlers)
        : await this.provider.complete(req); // no streaming → no deltas (e.g. stub)
      const cost = this.meter.record(tier, res.usage);
      return { ok: true, tier, text: res.text, usage: res.usage, costUsd: cost };
    } catch (err) {
      // Includes an intentional abort (signal) and any provider/network error.
      const aborted =
        (err as { name?: string })?.name === 'AbortError' ||
        (err as { name?: string })?.name === 'APIUserAbortError';
      return { ok: false, degraded: true, tier, reason: aborted ? 'aborted' : 'stream_error' };
    }
  }
}

// ---------------------------------------------------------------------------
// Real provider (P2 swap-in). Re-exported so consumers import it from the
// gateway's public surface; it implements the `LlmProvider` interface above.
// ---------------------------------------------------------------------------
export { AnthropicProvider, DEFAULT_MODELS } from './provider-anthropic.js';
export type { AnthropicProviderOptions } from './provider-anthropic.js';
