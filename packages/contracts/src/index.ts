/**
 * @aizen/contracts — the canonical Aizen data contracts (DECISIONS.md D06).
 *
 * Single source of truth, imported by every lane. zod schemas give static types
 * + runtime validation; `scripts/export-schema.ts` emits JSON Schema for the
 * registry and non-TS consumers (F02 Python, codegen).
 */
export * from './envelope.js';
export * from './consent.js';
export * from './audio-frame.js';
export * from './transcript-segment.js';
export * from './concept-card.js';
export * from './kg.js';
export * from './insight.js';
export * from './resync.js';
export * from './extraction-input.js';

// Golden-object builders for contract tests (shared across seam packages).
export * from './fixtures.js';
