import { z } from 'zod';
import { KnowledgeGraphNodeSchema, KnowledgeGraphEdgeSchema } from './kg.js';
import { ConsentClassSchema } from './consent.js';

/**
 * Seam C (doc 10 §3) — the `kg_delta` resync protocol that C-7 left as a prose
 * arrow. `kg_snapshot` (F02 produces, F04 stores/serves) + `kg_resync_request`
 * (F03→F04). The `delta_seq`↔bus-`Position` mapping lives in the DeltaIndex
 * (see @aizen/seam-kg-resync); these are the wire contracts.
 */

/** Opaque bus position token (Kinesis SequenceNumber / Kafka offset). M-5. */
export const PositionSchema = z.string().min(1);
export type Position = z.infer<typeof PositionSchema>;

export const KgSnapshotSchema = z.object({
  message_type: z.literal('kg_snapshot'),
  schema_version: z.string(),
  session_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  snapshot_id: z.string(),
  /** snapshot reflects ALL deltas with delta_seq <= this. */
  up_to_delta_seq: z.number().int().nonnegative(),
  /** the bus Position of `up_to_delta_seq` — the splice point to resume live. */
  up_to_position: PositionSchema,
  generated_at_us: z.number().int(),
  node_count: z.number().int().nonnegative(),
  edge_count: z.number().int().nonnegative(),
  nodes: z.array(KnowledgeGraphNodeSchema),
  edges: z.array(KnowledgeGraphEdgeSchema),
  /** hash of (sorted node ids+revisions + edge ids+revisions) — convergence check. */
  content_hash: z.string(),
  consent_class: ConsentClassSchema,
});
export type KgSnapshot = z.infer<typeof KgSnapshotSchema>;

export const ResyncReasonSchema = z.enum([
  'delta_seq_gap',
  'cold_start',
  'hash_mismatch',
  'reconnect',
]);

export const KgResyncRequestSchema = z.object({
  message_type: z.literal('kg_resync_request'),
  session_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  requester: z.string(),
  /** highest CONTIGUOUS delta_seq the requester has applied. */
  last_applied_delta_seq: z.number().int().nonnegative().nullable(),
  gap: z
    .object({
      missing_from: z.number().int().nonnegative(),
      observed: z.number().int().nonnegative(),
    })
    .nullable(),
  reason: ResyncReasonSchema,
  /** requester's replay tolerance before it prefers a snapshot. */
  max_replay: z.number().int().positive(),
});
export type KgResyncRequest = z.infer<typeof KgResyncRequestSchema>;
