/**
 * Deepgram streaming STT provider (P1, MAN-F01-002) — the BD-03 swap-in for the
 * deterministic `StubSttProvider`, behind the push-style `StreamingSttProvider`
 * interface (streaming.ts). It owns a Deepgram live WebSocket and maps Deepgram
 * results onto the canonical F01 `TranscriptSegment` lifecycle.
 *
 * Lifecycle mapping (F01 data-contracts §3.4): one Deepgram *utterance* becomes
 * one logical segment. Interim results emit growing `is_final:false` partials
 * (each a higher `rev` of the SAME `segment_id`); `is_final` results commit text;
 * the utterance closes on `speech_final` (or a backup `UtteranceEnd`) with a
 * single `is_final:true` final whose `rev` is highest and whose `supersedes`
 * points at its own `segment_id` — the in-place finalization the supersede seam
 * (INV-8) treats as a normal final, not a cross-segment correction.
 *
 * Audio in: raw PCM16LE mono @ 16 kHz (`encoding:'linear16'`, `sample_rate:16000`).
 */
import WebSocket from 'ws';
import { listen } from '@deepgram/sdk';
import type { TranscriptSegment } from '@aizen/contracts';
import type {
  SegmentSink,
  StreamingSttConfig,
  StreamingSttProvider,
  StreamingSttSession,
} from './streaming.js';

/** Deepgram live result message (the `type:'Results'` arm of the socket union). */
type DgResults = listen.ListenV1Results;
/** Any message the live socket can deliver. */
type DgMessage =
  | listen.ListenV1Results
  | listen.ListenV1Metadata
  | listen.ListenV1UtteranceEnd
  | listen.ListenV1SpeechStarted;

/** The socket surface this provider uses (subset of V1Socket; eases testing). */
export interface DeepgramLikeSocket {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (m: DgMessage) => void): void;
  on(event: 'close', cb: (e: unknown) => void): void;
  on(event: 'error', cb: (e: Error) => void): void;
  sendMedia(payload: ArrayBuffer | ArrayBufferView | Blob): void;
  sendCloseStream(message: listen.ListenV1CloseStream): void;
  close(): void;
  waitForOpen(): Promise<unknown>;
}

/** How to obtain a connected socket — overridable so tests inject a fake. */
export type SocketFactory = (
  cfg: Required<Pick<StreamingSttConfig, 'language' | 'model'>> & StreamingSttConfig,
) => Promise<DeepgramLikeSocket>;

export interface DeepgramProviderOptions {
  apiKey: string;
  /** Default model when a config omits one. */
  model?: string;
  /** Silence (ms) that ends an utterance server-side. */
  utteranceEndMs?: number;
  /** Inject a socket factory (tests). Defaults to a real Deepgram live socket. */
  connect?: SocketFactory;
  /** Max ms to wait for the live socket to open before failing (default 8000). */
  openTimeoutMs?: number;
}

/** Deepgram live endpoint host (overridable only via the injected factory). */
const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';

/**
 * The real default socket factory: a plain `ws` WebSocket to Deepgram's live
 * endpoint, wrapped to the small `DeepgramLikeSocket` surface. We deliberately
 * bypass the vendor SDK's `ReconnectingWebSocket`, which fails to open under
 * Node 20+/24 (the socket lands CLOSED with no `open`/`error` event, so the
 * SDK's `waitForOpen()` never settles and the whole session hangs). A direct
 * `ws` connection to the same endpoint opens reliably; `waitForOpen()` here is
 * guaranteed to settle (open → resolve; error/close/timeout → reject).
 */
function defaultConnect(opts: DeepgramProviderOptions): SocketFactory {
  const openTimeoutMs = opts.openTimeoutMs ?? 8000;
  return async (cfg) => {
    const params = new URLSearchParams({
      model: cfg.model,
      language: cfg.language,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      diarize: 'true',
      vad_events: 'true',
      utterance_end_ms: String(opts.utteranceEndMs ?? 1000),
    });
    const ws = new WebSocket(`${DEEPGRAM_LISTEN_URL}?${params.toString()}`, {
      headers: { Authorization: `Token ${opts.apiKey}` },
    });
    return wrapWsSocket(ws, openTimeoutMs);
  };
}

/** Adapt a raw `ws` WebSocket to the `DeepgramLikeSocket` surface the provider drives. */
function wrapWsSocket(ws: WebSocket, openTimeoutMs: number): DeepgramLikeSocket {
  return {
    on(event: string, cb: (arg: never) => void): void {
      if (event === 'open') {
        ws.on('open', () => (cb as () => void)());
      } else if (event === 'close') {
        ws.on('close', (code: number, reason: Buffer) =>
          (cb as (e: unknown) => void)({ code, reason: reason?.toString() }),
        );
      } else if (event === 'error') {
        ws.on('error', (err: Error) => (cb as (e: Error) => void)(err));
      } else if (event === 'message') {
        ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) return; // Deepgram delivers results as JSON text frames
          let msg: DgMessage;
          try {
            msg = JSON.parse(data.toString()) as DgMessage;
          } catch {
            return; // ignore non-JSON keepalive/control frames
          }
          (cb as (m: DgMessage) => void)(msg);
        });
      }
    },
    sendMedia(payload: ArrayBuffer | ArrayBufferView | Blob): void {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload as ArrayBuffer | ArrayBufferView);
    },
    sendCloseStream(): void {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
    },
    close(): void {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
    waitForOpen(): Promise<unknown> {
      if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(timer);
          ws.off('open', onOpen);
          ws.off('error', onError);
          ws.off('close', onClose);
        };
        const onOpen = (): void => {
          cleanup();
          resolve(undefined);
        };
        const onError = (err: Error): void => {
          cleanup();
          reject(err);
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error('deepgram socket closed before open'));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`deepgram socket open timed out after ${openTimeoutMs}ms`));
        }, openTimeoutMs);
        ws.on('open', onOpen);
        ws.on('error', onError);
        ws.on('close', onClose);
      });
    },
  };
}

export class DeepgramSttProvider implements StreamingSttProvider {
  private readonly connect: SocketFactory;
  private readonly model: string;

  constructor(opts: DeepgramProviderOptions) {
    if (!opts.apiKey && !opts.connect) {
      throw new Error('DeepgramSttProvider: apiKey (or a connect factory) is required');
    }
    this.model = opts.model ?? 'nova-2';
    this.connect = opts.connect ?? defaultConnect(opts);
  }

  async open(cfg: StreamingSttConfig, onSegment: SegmentSink): Promise<StreamingSttSession> {
    const full = { ...cfg, language: cfg.language ?? 'en-US', model: cfg.model ?? this.model };
    const socket = await this.connect(full);
    const mapper = new UtteranceMapper(full, onSegment);

    socket.on('message', (m) => {
      if (m.type === 'Results') mapper.onResults(m as DgResults);
      else if (m.type === 'UtteranceEnd') mapper.onUtteranceEnd();
    });
    socket.on('error', (e) => {
      // Phase-1 recovery is log-and-continue (the conductor restarts the session).
      // eslint-disable-next-line no-console
      console.error('[deepgram] socket error:', e);
    });

    await socket.waitForOpen().catch(() => undefined);

    return {
      sendAudio: (pcm) => socket.sendMedia(pcm as ArrayBuffer | ArrayBufferView),
      finish: async () => {
        mapper.flush();
        try {
          socket.sendCloseStream({ type: listen.ListenV1CloseStream.Type.CloseStream });
        } catch {
          /* socket may already be closing */
        }
        socket.close();
      },
    };
  }
}

/** Wall-clock µs (observability only; never used to order media). */
function nowUs(): number {
  return Date.now() * 1000;
}

/**
 * Folds the Deepgram result stream into the F01 partial→final lifecycle for one
 * session. Stateful across messages: one utterance == one `segment_id`.
 */
class UtteranceMapper {
  private uttIndex = 0;
  private rev = 0;
  private committed = ''; // finalized text accrued within the current utterance
  private uttStartMs: number | null = null;
  private lastEndMs = 0;
  private open = false; // a partial has been emitted but not yet finalized
  private readonly sessionStartAtUs = nowUs();

  constructor(
    private readonly cfg: StreamingSttConfig & { language: string },
    private readonly emit: SegmentSink,
  ) {}

  private segId(): string {
    return `${this.cfg.session_id}:seg:${this.uttIndex}`;
  }

  onResults(msg: DgResults): void {
    const alt = msg.channel?.alternatives?.[0];
    const piece = (alt?.transcript ?? '').trim();
    const startMs = Math.max(0, Math.round((msg.start ?? 0) * 1000));
    const endMs = Math.max(startMs, Math.round(((msg.start ?? 0) + (msg.duration ?? 0)) * 1000));

    if (piece && this.uttStartMs === null) this.uttStartMs = startMs;
    this.lastEndMs = endMs;

    if (msg.is_final && piece) {
      this.committed = this.committed ? `${this.committed} ${piece}` : piece;
    }

    if (msg.speech_final) {
      this.finalize(alt);
      return;
    }

    if (!piece) return; // empty interim — nothing to render
    const text = msg.is_final
      ? this.committed
      : this.committed
        ? `${this.committed} ${piece}`
        : piece;
    this.open = true;
    this.emitSegment(false, text, alt);
  }

  /** Backup endpoint: Deepgram's UtteranceEnd fires after `utterance_end_ms` silence. */
  onUtteranceEnd(): void {
    if (this.open || this.committed) this.finalize(undefined);
  }

  /** Caller-driven flush (session closing): finalize any in-flight utterance. */
  flush(): void {
    if (this.open || this.committed) this.finalize(undefined);
  }

  private finalize(alt: DgResults['channel']['alternatives'][number] | undefined): void {
    if (!this.committed && !this.open) return;
    const text = this.committed || '';
    if (text) this.emitSegment(true, text, alt);
    // reset for the next utterance
    this.uttIndex += 1;
    this.rev = 0;
    this.committed = '';
    this.uttStartMs = null;
    this.open = false;
  }

  private emitSegment(
    isFinal: boolean,
    text: string,
    alt: DgResults['channel']['alternatives'][number] | undefined,
  ): void {
    this.rev += 1;
    const speakerIdx = alt?.words?.find((w) => w.speaker !== undefined)?.speaker ?? 0;
    const seg: TranscriptSegment = {
      schema_version: '1.0.0',
      tenant_id: this.cfg.tenant_id,
      session_id: this.cfg.session_id,
      seq: 0, // assigned by the worker via the bus before publish
      producer_id: 'deepgram-stt-worker',
      emitted_at: nowUs(),
      segment_id: this.segId(),
      rev: this.rev,
      is_final: isFinal,
      // §3.4: a final replaces the last partial of its OWN segment (in-place).
      supersedes: isFinal ? this.segId() : null,
      start_ms: this.uttStartMs ?? 0,
      end_ms: Math.max(this.lastEndMs, this.uttStartMs ?? 0),
      session_start_at: this.sessionStartAtUs,
      text,
      language: this.cfg.language,
      confidence: alt?.confidence ?? (isFinal ? 0.9 : 0.6),
      confidence_band: isFinal ? 'high' : 'medium',
      speaker: {
        speaker_id: `spk_${speakerIdx + 1}`,
        speaker_confidence: 0.8,
        participant_id: null,
        display_name: `Speaker ${speakerIdx + 1}`,
        channel_role: 'local_participant',
        is_overlap: false,
        diarization_method: 'online_clustering',
      },
      consent: {
        mode: this.cfg.consentMode ?? 'store_audio',
        consent_id: this.cfg.consentId ?? 'c_local',
        pii_redacted: false,
      },
    };
    this.emit(seg);
  }
}
