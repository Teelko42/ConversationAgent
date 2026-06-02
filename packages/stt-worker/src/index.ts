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
