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

// --- P2 enrichment ("explain engine", lite): skeleton → enriched card ---
export { enrichCard, type EnrichOptions } from './enrich.js';
export {
  runEnrich,
  type RunEnrichHandle,
  type RunEnrichOptions,
} from './enrich-worker.js';

// --- LIVE intelligence worker: continuous concept cards + insights + recap + KG ---
export {
  runLiveIntel,
  type RunLiveIntelHandle,
  type RunLiveIntelOptions,
} from './live-intel.js';

// --- P2 sentence explain engine: explain a sentence + break down words + answer questions ---
export {
  explainSentence,
  looksLikeQuestion,
  pickKeyWords,
  type ExplainInput,
  type ExplainOptions,
  type ExplainHooks,
  type AnswerStreamHooks,
} from './explain.js';

// --- F1 follow-up engine: answer a typed question about an explained sentence ---
export {
  answerFollowup,
  type FollowupInput,
  type FollowupContext,
  type FollowupOptions,
} from './explain.js';
