/**
 * One live session's wiring — the real-time analogue of `SessionConductor`, but
 * driven by a browser microphone instead of the fixture clip. It builds ONE
 * BD-01 bus, gates on consent (fail-closed), wires Lane D (`runIntel`) + the P2
 * enrichment worker, and attaches a transcription source:
 *
 *   • live mode  (Deepgram key present): browser PCM → Deepgram → TranscriptSegments
 *   • demo mode  (no key):              the deterministic stub spine (MockClip +
 *                                       StubStt) so the page still shows the
 *                                       "ARR" flow — and, if an Anthropic key is
 *                                       set, a REAL enriched explanation of it.
 *
 * Every envelope published on the bus is forwarded to `onEnvelope` (the server
 * relays it to the browser), so the client renders transcript + concept cards as
 * they happen. Providers are chosen by key presence (BD-03 swap), so the same
 * wiring runs stubbed or real with no code change.
 */
import { randomUUID } from 'node:crypto';
import type { Envelope } from '@aizen/edge-gateway';
import { InMemorySessionBus, ConsentGate } from '@aizen/edge-gateway';
import {
  LlmGateway,
  StubProvider,
  AnthropicProvider,
  CostMeter,
  type LlmProvider,
} from '@aizen/llm-gateway';
import { makeWebSearchProvider, type WebSearchProvider } from '@aizen/research';
import { explainSentence, answerFollowup } from '@aizen/intel-worker';
import type { FollowupAnswer, SentenceExplanation, UserSource } from '@aizen/contracts';
import {
  StubSttProvider,
  runStt,
  DeepgramSttProvider,
  runStreamingStt,
  type StreamingSttHandle,
  type SttHandle,
} from '@aizen/stt-worker';
import {
  MockClipSource,
  startCapture,
  type AudioChunk,
  type CaptureHandle,
} from '@aizen/capture';
import { makeConsentContext } from '@aizen/contracts';
import type { AppConfig, ProviderStatus } from './config.js';

export interface SessionHandle {
  sessionId: string;
  mode: 'live' | 'demo';
  /** Feed raw PCM16LE 16 kHz mono audio (live mode); no-op in demo mode. */
  sendAudio(pcm: Uint8Array): void;
  /**
   * On-demand: explain one transcript sentence — plain meaning + a breakdown of
   * its key words, and (when it is a question) a short answer grounded in web
   * search and/or the user's own provided sources (F2). Driven by an F03 click, so
   * it runs only for sentences the user picks.
   *
   * `userSources` is the BYO-context the browser ships with the request (F2 §6):
   * it survives a WS reconnect because the client re-sends it each time, so a
   * question can be answered from user context even with no web-search key.
   */
  explain(segmentId: string, text: string, userSources?: UserSource[]): Promise<SentenceExplanation>;
  /**
   * On-demand: answer a user-typed FOLLOW-UP question about a sentence that was
   * just explained, grounded in the recent transcript context + web sources (F1).
   * `askId` is the client-generated correlation id echoed back on the reply frame.
   *
   * `clientContext` carries the sentence + recent transcript the BROWSER is asking
   * about. It is preferred over this session's own rolling buffer because the
   * buffer is empty on a freshly (re)connected session — the browser keeps the
   * transcript across reconnects, the server does not — so without it a
   * context-dependent follow-up asked after a reconnect would lose its grounding.
   * Falls back to the server-side buffer when absent (older client / safety).
   *
   * Always resolves (degraded on a stubbed/capped gateway) — never throws.
   */
  ask(
    segmentId: string,
    question: string,
    askId: string,
    clientContext?: { sentence?: string; transcript?: string[] },
    userSources?: UserSource[],
  ): Promise<FollowupAnswer>;
  stop(): Promise<void>;
}

/** How many recent FINAL transcript lines to keep as follow-up context. */
const FOLLOWUP_CONTEXT_LINES = 12;

/** A TranscriptSegment (F01) carries these; an AudioFrame / F02 envelope does not. */
function isFinalTranscript(env: unknown): env is { segment_id: string; text: string } {
  const e = env as { segment_id?: unknown; text?: unknown; is_final?: unknown; message_type?: unknown };
  return (
    !!e &&
    e.message_type === undefined &&
    typeof e.segment_id === 'string' &&
    typeof e.text === 'string' &&
    e.is_final === true
  );
}

/** Per-session safety ceilings (doc 11) — cost is this project's #1 risk. */
const TENANT_CEILING_USD = 5;
const OPUS_CALL_CAP = 4;

/**
 * Hard ceiling on a single on-demand explain/follow-up. The engine already bounds
 * its own web-search + model calls, but this is the backstop that GUARANTEES the
 * WS handler always gets a reply to send: if anything upstream wedges past this, we
 * resolve a degraded result instead of leaving the browser on "Answering…" forever.
 */
const ONDEMAND_TIMEOUT_MS = 30000;

/**
 * Resolve `p`, but if it hasn't settled within `ms`, resolve `onTimeout()` instead
 * (and swallow a late rejection). Never rejects — so the caller always has a value
 * to reply with.
 */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref?: () => void }).unref!();
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout());
      },
    );
  });
}

/** Build the LLM gateway: real Anthropic if keyed, else the deterministic stub. */
function buildGateway(cfg: AppConfig): LlmGateway {
  const provider: LlmProvider = cfg.anthropicApiKey
    ? new AnthropicProvider({ apiKey: cfg.anthropicApiKey })
    : new StubProvider();
  return new LlmGateway(
    provider,
    new CostMeter({ tenantCeilingUsd: TENANT_CEILING_USD, opusCallCap: OPUS_CALL_CAP }),
  );
}

/** The demo clip: four speech frames + a closing endpoint (silence) frame. */
function demoClip(): AudioChunk[] {
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 4; i++) chunks.push({ startMs: i * 20, durationMs: 20, samples: 320 });
  chunks.push({ startMs: 80, durationMs: 0, samples: 0 }); // endpoint → finalize
  return chunks;
}

/**
 * Create and start a live session. Throws (fail-closed) if consent is refused —
 * the caller should close the socket. Returns a handle to feed audio + stop.
 */
export async function createSession(
  cfg: AppConfig,
  status: ProviderStatus,
  onEnvelope: (env: Envelope) => void,
): Promise<SessionHandle> {
  const sessionId = randomUUID();
  const consent = makeConsentContext({ session_id: sessionId });

  // Fail-closed ingress gate BEFORE any bus/worker exists (D18/D20).
  if (!new ConsentGate().admit(sessionId, consent)) {
    throw new Error('consent refused (fail-closed)');
  }

  const bus = new InMemorySessionBus();
  const gateway = buildGateway(cfg);
  const research: WebSearchProvider = makeWebSearchProvider({
    provider: cfg.webSearchProvider,
    tavilyApiKey: cfg.tavilyApiKey,
  });

  // A short rolling buffer of recent FINAL transcript lines, kept so a typed
  // follow-up ("what did he mean by that?") can be answered against conversation
  // context — the explain path never sees the transcript, but a follow-up must.
  // Keyed by segment_id (a finalized segment can be re-emitted) and capped.
  const recentFinals: { segment_id: string; text: string }[] = [];
  function rememberFinal(segment_id: string, text: string): void {
    const at = recentFinals.findIndex((r) => r.segment_id === segment_id);
    if (at >= 0) recentFinals[at] = { segment_id, text };
    else {
      recentFinals.push({ segment_id, text });
      if (recentFinals.length > FOLLOWUP_CONTEXT_LINES) recentFinals.shift();
    }
  }

  // Forward every bus envelope to the browser (subscribe before any producer).
  // The live view shows transcript sentences; explanations are produced on demand
  // (per the F03 click → `explain`), not auto-emitted per term — so no extraction
  // or enrichment worker is wired here. We also snapshot final transcript lines
  // into `recentFinals` here (the session already sees every envelope it forwards).
  const unsubForward = bus.subscribe(sessionId, 0, (env) => {
    if (isFinalTranscript(env)) rememberFinal(env.segment_id, env.text);
    onEnvelope(env);
  });

  let mode: 'live' | 'demo';
  let stream: StreamingSttHandle | undefined;
  let sttStub: SttHandle | undefined;
  let capture: CaptureHandle | undefined;

  if (status.stt === 'deepgram' && cfg.deepgramApiKey) {
    // LIVE: browser mic → Deepgram → TranscriptSegments on the bus. A failure to
    // open the vendor socket must NOT hang or reject session creation (that would
    // leave the client's "Start listening" button disabled forever) — we log and
    // still return a live session so the page is usable.
    mode = 'live';
    try {
      stream = await runStreamingStt(
        sessionId,
        bus,
        new DeepgramSttProvider({ apiKey: cfg.deepgramApiKey }),
        {
          session_id: sessionId,
          tenant_id: cfg.tenantId,
          language: 'en-US',
          consentMode: 'store_audio',
          consentId: 'c_local',
        },
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[session] live STT failed to start:', err);
    }
  } else {
    // DEMO: drive the deterministic stub spine once so the page shows the flow.
    mode = 'demo';
    sttStub = runStt(sessionId, bus, new StubSttProvider({ wordsPerUtterance: 4 }));
    capture = startCapture(sessionId, new MockClipSource(demoClip()), bus, {
      tenantId: cfg.tenantId,
    });
  }

  return {
    sessionId,
    mode,
    sendAudio: (pcm) => stream?.sendAudio(pcm),
    explain: (segmentId, text, userSources) =>
      withTimeout(
        explainSentence(
          { segment_id: segmentId, session_id: sessionId, tenant_id: cfg.tenantId, text },
          gateway,
          {
            research: status.search === 'tavily' ? research : undefined,
            ...(userSources && userSources.length ? { userSources } : {}),
          },
        ),
        ONDEMAND_TIMEOUT_MS,
        () => ({
          id: `se_${segmentId}`,
          session_id: sessionId,
          tenant_id: cfg.tenantId,
          segment_id: segmentId,
          sentence: text,
          explanation: 'Timed out while explaining — please try again.',
          breakdown: [],
          is_question: false,
          answer: null,
          sources: [],
          state: 'degraded',
        }),
      ),
    ask: (segmentId, question, _askId, clientContext, userSources) => {
      // Prefer the context the client shipped with the ask (its model survives WS
      // reconnects, whereas this session's `recentFinals` starts empty after one).
      // Fall back to the named segment's sentence, then the most recent final line,
      // and to the server-side rolling buffer for the transcript.
      const clientTranscript = (clientContext?.transcript ?? [])
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter(Boolean);
      const clientSentence = (clientContext?.sentence ?? '').trim();
      const about = recentFinals.find((r) => r.segment_id === segmentId);
      const sentence =
        clientSentence || about?.text || recentFinals[recentFinals.length - 1]?.text || '';
      const transcript = clientTranscript.length > 0 ? clientTranscript : recentFinals.map((r) => r.text);
      return withTimeout(
        answerFollowup(
          {
            segment_id: segmentId,
            session_id: sessionId,
            tenant_id: cfg.tenantId,
            question,
            context: { sentence, transcript },
          },
          gateway,
          {
            research: status.search === 'tavily' ? research : undefined,
            ...(userSources && userSources.length ? { userSources } : {}),
          },
        ),
        ONDEMAND_TIMEOUT_MS,
        () => ({
          id: `fu_${segmentId}`,
          session_id: sessionId,
          tenant_id: cfg.tenantId,
          segment_id: segmentId,
          question,
          answer: null,
          sources: [],
          state: 'degraded',
        }),
      );
    },
    stop: async () => {
      capture?.stop();
      sttStub?.stop();
      if (stream) await stream.stop();
      unsubForward();
    },
  };
}
