import { z } from 'zod';

/**
 * D06 — shared message identity/ordering envelope.
 *
 * Two clock domains exist and MUST NOT be conflated (F01 data-contracts §1):
 *  - media time (`*_ms` / `*_us` offsets from session_start) — authoritative for
 *    ordering of audio content; drift-free relative to the media.
 *  - wall-clock (`emitted_at` / `ts_emit`, µs Unix epoch) — latency/observability
 *    only; subject to NTP skew; never used to order media (M-3).
 *
 * `seq` is logically uint64 (monotonic per session, per message class). JSON
 * numbers lose precision above 2^53, so the wire format may carry it as a string
 * at scale; Phase-0 models it as a non-negative integer.
 */
export const SeqSchema = z.number().int().nonnegative();

/** Media-clock microseconds (offset from session_start). Never wall-clock. */
export const MediaUsSchema = z.number().int().nonnegative();

/** F01-produced envelope (AudioFrame, TranscriptSegment). */
export const F01EnvelopeSchema = z.object({
  schema_version: z.string(),
  tenant_id: z.string().uuid(),
  session_id: z.string().uuid(),
  seq: SeqSchema,
  producer_id: z.string().min(1),
  /** wall-clock µs epoch (observability only). */
  emitted_at: z.number().int(),
});
export type F01Envelope = z.infer<typeof F01EnvelopeSchema>;

export const F02MessageTypeSchema = z.enum([
  'concept_card',
  'kg_node',
  'kg_edge',
  'insight_item',
  'kg_delta',
  'kg_snapshot',
  // Live "what you've missed" recap (live-intel worker). Additive: a periodic,
  // best-effort summary that rides the same F02 envelope to the browser. NOT a
  // Phase-0 artifact — it carries a `SessionSummary` payload (see session-summary.ts).
  'session_summary',
]);
export type F02MessageType = z.infer<typeof F02MessageTypeSchema>;

/** F02-produced envelope (ConceptCard, KG*, InsightItem, kg_delta, kg_snapshot). */
export const F02EnvelopeSchema = z.object({
  schema_version: z.string(),
  message_type: F02MessageTypeSchema,
  session_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  seq: SeqSchema,
  /** wall-clock µs epoch (observability only). */
  ts_emit: z.number().int(),
  producer: z.string().min(1),
  trace_id: z.string().min(1),
});
export type F02Envelope = z.infer<typeof F02EnvelopeSchema>;
