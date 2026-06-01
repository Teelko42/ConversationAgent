import { z } from 'zod';
import { ConsentClassSchema } from './consent.js';

/** F02 knowledge-graph contracts (F02 data-contracts §3–4) + `kg_delta`. */

export const KgNodeTypeSchema = z.enum([
  'concept',
  'topic',
  'entity',
  'speaker',
  'insight',
  'document',
  'event',
]);

export const KnowledgeGraphNodeSchema = z.object({
  id: z.string(), // kgn_… ULID
  revision: z.number().int().nonnegative(),
  session_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  label: z.string(),
  node_type: KgNodeTypeSchema,
  concept_card_id: z.string().nullable(),
  domain: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  salience: z.number().min(0).max(1).optional(),
  degree: z.number().int().nonnegative().optional(),
  first_seen_segment_id: z.string().optional(),
  first_seen_t_us: z.number().int().nonnegative().optional(),
  last_seen_t_us: z.number().int().nonnegative().optional(),
  embedding_ref: z.string().nullable().optional(),
  consent_class: ConsentClassSchema,
});
export type KnowledgeGraphNode = z.infer<typeof KnowledgeGraphNodeSchema>;

export const KgRelationSchema = z.enum([
  'mentions',
  'discusses',
  'defines',
  'is_a',
  'part_of',
  'causes',
  'depends_on',
  'contrasts_with',
  'example_of',
  'attributed_to',
  'decided_by',
  'raised_by',
  'references',
  'temporal_follows',
  'same_as',
  'related_to',
]);

export const KnowledgeGraphEdgeSchema = z.object({
  id: z.string(), // kge_… ULID
  revision: z.number().int().nonnegative(),
  session_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  src: z.string(),
  dst: z.string(),
  relation: KgRelationSchema,
  directed: z.boolean(),
  weight: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence_segment_ids: z.array(z.string()).optional(),
});
export type KnowledgeGraphEdge = z.infer<typeof KnowledgeGraphEdgeSchema>;

/**
 * `kg_delta` payload — incremental graph mutation. `delta_seq` is F02's
 * application-level counter; F03 applies in order and requests resync on a gap.
 * Retraction (INV-8) flows through `remove_node_ids` / `remove_edge_ids`.
 */
export const KgDeltaSchema = z.object({
  session_id: z.string().uuid(),
  delta_seq: z.number().int().nonnegative(),
  upsert_nodes: z.array(KnowledgeGraphNodeSchema).default([]),
  upsert_edges: z.array(KnowledgeGraphEdgeSchema).default([]),
  remove_node_ids: z.array(z.string()).default([]),
  remove_edge_ids: z.array(z.string()).default([]),
  /** true ⇒ a checkpoint snapshot ≥ this delta_seq exists for gap recovery. */
  snapshot_offer: z.boolean().default(false),
});
export type KgDelta = z.infer<typeof KgDeltaSchema>;
