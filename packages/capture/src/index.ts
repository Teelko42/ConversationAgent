/**
 * @aizen/capture — Lane B. Source -> AudioFrame -> bus (BD-01). The Phase-0
 * source is the deterministic `MockClipSource`; `startCapture` mints frames with
 * gateway-assigned `seq` and publishes them. See
 * .claudetrees/runs/20260601-phase0-spine/features/B-capture/PLAN.md.
 */
export type { AudioChunk, CaptureSource } from './source.js';
export { MockClipSource } from './source.js';
export type { CaptureHandle } from './capture.js';
export { startCapture } from './capture.js';
