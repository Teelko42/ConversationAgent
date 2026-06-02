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
import {
  runIntel,
  runEnrich,
  type RunIntelHandle,
  type RunEnrichHandle,
} from '@aizen/intel-worker';
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
  stop(): Promise<void>;
}

/** Per-session safety ceilings (doc 11) — cost is this project's #1 risk. */
const TENANT_CEILING_USD = 5;
const OPUS_CALL_CAP = 4;

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

  // Forward every bus envelope to the browser (subscribe before workers publish).
  const unsubForward = bus.subscribe(sessionId, 0, onEnvelope);

  // Lane D + enrichment first, so they see every later F01/F02 envelope.
  const intel: RunIntelHandle = runIntel(sessionId, bus, gateway, { consent });
  const enrich: RunEnrichHandle = runEnrich(sessionId, bus, gateway, {
    research: status.search === 'tavily' ? research : undefined,
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
    stop: async () => {
      capture?.stop();
      sttStub?.stop();
      if (stream) await stream.stop();
      // let in-flight extraction + enrichment settle, then detach.
      await intel.drain().catch(() => undefined);
      await enrich.drain().catch(() => undefined);
      intel.stop();
      enrich.stop();
      unsubForward();
    },
  };
}
