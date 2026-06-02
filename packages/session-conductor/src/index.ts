/**
 * @aizen/session-conductor — Lane E (F03·T7). Orchestrates the per-session spine
 * (capture → stt → intel over one BD-01 bus, consent-gated, with a
 * failure-recovery stub) and owns the Phase-0 exit test (CT-E2E-1 / BD-05).
 */
export {
  SessionConductor,
  type ConductorStartOptions,
} from './conductor.js';
