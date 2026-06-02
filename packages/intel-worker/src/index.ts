/**
 * @aizen/intel-worker — Lane D. The F02 hot path on the stub spine (BD-04):
 * `TranscriptSegment` → `adapt()` (D16) → on FINALS, skeleton `ConceptCard` /
 * `InsightItem` / `kg_delta` via the LLM gateway; provenance + supersede (INV-8)
 * + delta index. See features/D-intel-worker/PLAN.md.
 */
export { extractFromFinal, salientTerms, type ExtractResult } from './extract.js';
export {
  runIntel,
  type RunIntelHandle,
  type RunIntelOptions,
  type F02Payload,
  type F02Out,
} from './worker.js';
