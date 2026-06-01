import { z } from 'zod';
import { ConsentClassSchema } from './consent.js';

/**
 * F02 `InsightItem` (F02 data-contracts §5).
 *
 * M-2 reconciliation (doc 10 §4): F02 names are authoritative — F03 renders by
 * these names. NOT `kind`/`assignee`/`ts_start` (the stale F03 assumptions).
 */
export const InsightTypeSchema = z.enum([
  'action_item',
  'decision',
  'open_question',
  'risk',
  'commitment',
]);
export type InsightType = z.infer<typeof InsightTypeSchema>;

export const InsightStatusSchema = z.enum([
  'open',
  'resolved',
  'superseded', // reused by Seam B for correction propagation
  'dismissed',
]);

export const InsightItemSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  session_id: z.string().uuid(),
  tenant_id: z.string().uuid(),

  insight_type: InsightTypeSchema, // NOT `kind` (M-2)
  status: InsightStatusSchema,
  text: z.string(),
  normalized_text: z.string().optional(),

  owner_speaker_id: z.string().nullable(), // NOT `assignee` (M-2)
  raised_by_speaker_id: z.string().nullable().optional(),
  due: z
    .object({
      raw: z.string(),
      resolved_iso: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    })
    .optional(),

  evidence_segment_ids: z.array(z.string()).min(1), // INV-4: non-empty
  first_seen_t_us: z.number().int().nonnegative(), // NOT `ts_start/ts_end` (M-2)
  graph_node_id: z.string().nullable().optional(),
  related_concept_ids: z.array(z.string()).optional(),

  confidence: z.number().min(0).max(1).optional(),
  salience: z.number().min(0).max(1).optional(),
  consent_class: ConsentClassSchema,
  pii_present: z.boolean(),

  // doc 10 Seam B — set when a supersede correction obsoletes this insight.
  superseded_by_segment_id: z.string().nullable().optional(),
});
export type InsightItem = z.infer<typeof InsightItemSchema>;
