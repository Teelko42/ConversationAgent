import { z } from 'zod';
import { F01EnvelopeSchema } from './envelope.js';

/**
 * F01 `TranscriptSegment` (F01 data-contracts §3) — the F01→F02 seam.
 * Authoritative shape F02 consumes via the D16 adapter (by name only).
 *
 * `rev` and `supersedes` carry correction semantics and MUST survive the adapter
 * (doc 10 Seam A INV-A1 / H-7). `is_final` gates extraction; partials drive
 * speculative extraction (D17).
 */

const WordSchema = z.object({
  w: z.string(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  speaker_id: z.string(),
  is_domain_term: z.boolean(),
  alt: z.string().nullable(),
});

const SpeakerSchema = z.object({
  speaker_id: z.string(),
  speaker_confidence: z.number().min(0).max(1),
  participant_id: z.string().nullable(),
  display_name: z.string(),
  channel_role: z.string(),
  is_overlap: z.boolean(),
  diarization_method: z.string(),
});

export const ConfidenceBandSchema = z.enum(['high', 'medium', 'low']);

export const TranscriptSegmentSchema = F01EnvelopeSchema.extend({
  // identity & lifecycle
  segment_id: z.string(), // opaque `{session}:seg:{seq}` — NOT a uuid (C-2)
  rev: z.number().int().nonnegative(),
  is_final: z.boolean(),
  supersedes: z.string().nullable(), // segment_id this correction replaces (§3.4)

  // timing (media clock, ms)
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  session_start_at: z.number().int(),

  // recognized content
  text: z.string(),
  language: z.string(), // BCP-47
  language_confidence: z.number().min(0).max(1).nullable().optional(),
  words: z.array(WordSchema).optional(), // present on finals, best-effort on partials

  // confidence (D05)
  confidence: z.number().min(0).max(1),
  confidence_band: ConfidenceBandSchema,
  no_speech_prob: z.number().min(0).max(1).optional(),

  // diarization / speaker
  speaker: SpeakerSchema,

  // domain biasing trace (best-effort)
  domain_terms: z
    .array(
      z.object({
        term: z.string(),
        canonical: z.string(),
        source: z.string(),
        char_start: z.number().int().nonnegative(),
        char_end: z.number().int().nonnegative(),
      }),
    )
    .optional(),

  // latency telemetry (best-effort)
  timing_meta: z
    .object({
      first_partial_at: z.number().int(),
      final_at: z.number().int(),
      audio_end_to_partial_ms: z.number().int().nonnegative(),
      audio_end_to_final_ms: z.number().int().nonnegative(),
      rtf: z.number().nonnegative(),
    })
    .optional(),

  // provenance & correction
  frame_seq_range: z.tuple([z.number().int(), z.number().int()]).optional(),
  corrected_by: z.enum(['endpointer', 'llm_postedit', 'user']).nullable().optional(),

  // consent passthrough (D10)
  consent: z.object({
    mode: z.enum(['store_audio', 'no_audio_retention', 'transcript_only']),
    consent_id: z.string(),
    pii_redacted: z.boolean(),
  }),
}).superRefine((seg, ctx) => {
  if (seg.end_ms < seg.start_ms) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'end_ms must be >= start_ms (media clock)',
      path: ['end_ms'],
    });
  }
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
