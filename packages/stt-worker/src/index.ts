/**
 * @aizen/stt-worker — Lane C. AudioFrame -> TranscriptSegment (stub provider).
 *
 * The STT seam (BD-03): `SttProvider`/`StubSttProvider` reproduce the F01
 * partial→final lifecycle (rev/supersedes, §3.4); `runStt` wires the provider
 * onto the per-session bus (BD-01). Deepgram swaps in behind `SttProvider` at P1.
 */
export type { SttProvider, SttResult } from './provider.js';
export { StubSttProvider } from './provider.js';
export type { SttHandle } from './worker.js';
export { runStt } from './worker.js';

// --- P1 streaming seam (real-time) + Deepgram swap-in (BD-03) ---
export type {
  SegmentSink,
  StreamingSttConfig,
  StreamingSttSession,
  StreamingSttProvider,
  StreamingSttHandle,
} from './streaming.js';
export { runStreamingStt } from './streaming.js';
export type {
  DeepgramProviderOptions,
  DeepgramLikeSocket,
  SocketFactory,
} from './provider-deepgram.js';
export { DeepgramSttProvider } from './provider-deepgram.js';
