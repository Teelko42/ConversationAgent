import { z } from 'zod';
import { ConsentClassSchema } from './consent.js';

/**
 * F02 `ConceptCard` (F02 data-contracts §2). The F02→F03 seam.
 *
 * Hardened-spec addition (doc 10 Seam B / INV-8): a `retracted` state + a
 * `retraction` block so F03 can UN-render a card whose source was superseded —
 * the missing piece that let stale cards cite superseded text (H-8).
 */

export const CardStateSchema = z.enum([
  'skeleton',
  'enriched',
  'deep',
  'error',
  'retracted', // doc 10 Seam B — F03 removes the card
]);
export type CardState = z.infer<typeof CardStateSchema>;

export const CardKindSchema = z.enum([
  'topic',
  'concept',
  'acronym',
  'entity_person',
  'entity_org',
  'entity_product',
  'entity_location',
  'entity_financial_instrument',
  'entity_legal_ref',
  'entity_medical',
  'event',
  'metric',
  'jargon_term',
  'reference',
]);

export const RetractionReasonSchema = z.enum([
  'source_superseded',
  'merged',
  'user_edit',
  'refuted',
]);

const CitationSchema = z.object({
  citation_id: z.string(),
  type: z.enum(['transcript', 'web', 'internal_doc', 'model_parametric']),
  transcript_segment_ids: z.array(z.string()).optional(),
  url: z.string().optional(),
  doc_id: z.string().optional(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  retrieved_at: z.string().optional(),
  trust_tier: z.enum(['T1', 'T2', 'T3', 'T4']).optional(),
  support_score: z.number().min(0).max(1).optional(),
});

export const ConceptCardSchema = z.object({
  id: z.string(), // ULID, stable across revisions
  revision: z.number().int().nonnegative(),
  state: CardStateSchema,
  session_id: z.string().uuid(),
  tenant_id: z.string().uuid(),

  surface_form: z.string(),
  canonical_name: z.string(),
  kind: CardKindSchema,
  domain: z.string(),
  salience: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1).optional(),

  definition_short: z.string().optional(),
  // explanation block omitted from the Phase-0 floor; added with the explain engine.

  sources: z.array(CitationSchema),

  graph_node_id: z.string().nullable().optional(),
  related_concept_ids: z.array(z.string()).optional(),

  first_mention: z
    .object({
      segment_id: z.string(),
      t_start_us: z.number().int().nonnegative(),
      speaker_id: z.string(),
    })
    .optional(),
  mention_count: z.number().int().nonnegative().optional(),
  mention_segment_ids: z.array(z.string()).optional(),

  grounding: z
    .object({
      grounded: z.boolean(),
      groundedness_score: z.number().min(0).max(1),
      verification_state: z.enum(['unverified', 'verified', 'contested', 'refuted']),
      hallucination_flags: z.array(z.string()),
    })
    .optional(),

  consent_class: ConsentClassSchema, // D10/INV-6
  pii_present: z.boolean(),

  // --- doc 10 Seam B / INV-8 (additive, v1 minor) ---
  retraction: z
    .object({
      reason: RetractionReasonSchema,
      superseded_segment_id: z.string(),
      replacement_card_id: z.string().nullable(),
    })
    .nullable()
    .optional(),

  created_at_us: z.number().int().nonnegative().optional(),
  updated_at_us: z.number().int().nonnegative().optional(),
}).superRefine((card, ctx) => {
  // INV-8: a retracted card MUST carry a retraction block, and vice-versa.
  if (card.state === 'retracted' && !card.retraction) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'state=retracted requires a retraction{} block (INV-8)',
      path: ['retraction'],
    });
  }
  if (card.retraction && card.state !== 'retracted') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'retraction{} present but state != retracted (INV-8)',
      path: ['state'],
    });
  }
});
export type ConceptCard = z.infer<typeof ConceptCardSchema>;
