import { z } from 'zod';
import { ConsentClassSchema } from './consent.js';

/**
 * `ExtractionInput` — the normalized view the D16 adapter produces (doc 10 §1.2).
 * The ONLY shape F02 extraction sees; no downstream code touches raw F01 fields.
 *
 * Time fields are MEDIA-clock µs (`clock: 'media'`, INV-A2) — never wall-clock.
 * `rev`/`supersedes` are carried (INV-A1). `consent_class`/`pii_present` are
 * stamped from ConsentContext, fail-closed when absent (INV-A4 / D20).
 */
export const ExtractionInputSchema = z.object({
  // identity
  segment_id: z.string(), // opaque string (C-2)
  session_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  seq: z.number().int().nonnegative(),

  // content
  text: z.string(),
  lang: z.string(), // renamed from F01 `language`

  // lifecycle / correction
  is_final: z.boolean(),
  rev: z.number().int().nonnegative(), // RESTORED (H-7)
  supersedes: z.string().nullable(), // RESTORED (H-7)

  // timing — media clock µs (×1000 from F01 ms)
  clock: z.literal('media'),
  t_start_us: z.number().int().nonnegative(),
  t_end_us: z.number().int().nonnegative(),

  // speaker (unwrapped from nested F01 object)
  speaker_id: z.string(),
  speaker_label: z.string(),
  speaker_confidence: z.number().min(0).max(1),
  participant_id: z.string().nullable(),

  // confidence
  confidence: z.number().min(0).max(1),
  confidence_band: z.enum(['high', 'medium', 'low']),

  // consent passthrough
  consent_mode: z.enum(['store_audio', 'no_audio_retention', 'transcript_only']),
  consent_id: z.string(),
  pii_redacted_upstream: z.boolean(),

  // derived sensitivity (NOT from F01 — from ConsentContext; fail-closed)
  consent_class: ConsentClassSchema,
  pii_present: z.boolean(),
});
export type ExtractionInput = z.infer<typeof ExtractionInputSchema>;
