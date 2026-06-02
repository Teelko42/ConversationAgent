/**
 * @aizen/edge-gateway — Lane A. The per-session ordered event bus (BD-01),
 * the seq assigner, and the fail-closed consent gate. Other lanes import the
 * `SessionEventBus` interface from here and publish/subscribe through it.
 */
export * from './bus.js';
export * from './seq.js';
export * from './consent-gate.js';
