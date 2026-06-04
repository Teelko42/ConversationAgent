/**
 * Emit JSON Schema for every canonical contract → `schema/` (the registry
 * artifact, committed). Run: `pnpm --filter @aizen/contracts run export-schema`.
 *
 * This is what lets non-TS consumers (F02 Python, codegen) share the exact
 * contracts without re-declaring them — honoring D06 "reference by name only".
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  AudioFrameSchema,
  TranscriptSegmentSchema,
  ConceptCardSchema,
  KnowledgeGraphNodeSchema,
  KnowledgeGraphEdgeSchema,
  KgDeltaSchema,
  InsightItemSchema,
  KgSnapshotSchema,
  KgResyncRequestSchema,
  ConsentContextSchema,
  ExtractionInputSchema,
  AccountSchema,
  IdentitySchema,
  EntitlementSchema,
  SavedSessionSchema,
  StoredArtifactSchema,
  StoredSourceSchema,
  SourceQuotaStatusSchema,
  QuotaStatusSchema,
  QuotaErrorSchema,
  UserSourceSchema,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'schema');
mkdirSync(outDir, { recursive: true });

const registry: Record<string, unknown> = {
  'audio_frame.schema.json': AudioFrameSchema,
  'transcript_segment.schema.json': TranscriptSegmentSchema,
  'concept_card.schema.json': ConceptCardSchema,
  'knowledge_graph_node.schema.json': KnowledgeGraphNodeSchema,
  'knowledge_graph_edge.schema.json': KnowledgeGraphEdgeSchema,
  'kg_delta.schema.json': KgDeltaSchema,
  'insight_item.schema.json': InsightItemSchema,
  'kg_snapshot.schema.json': KgSnapshotSchema,
  'kg_resync_request.schema.json': KgResyncRequestSchema,
  'consent_context.schema.json': ConsentContextSchema,
  'extraction_input.schema.json': ExtractionInputSchema,
  'account.schema.json': AccountSchema,
  'identity.schema.json': IdentitySchema,
  'entitlement.schema.json': EntitlementSchema,
  'saved_session.schema.json': SavedSessionSchema,
  'stored_artifact.schema.json': StoredArtifactSchema,
  'stored_source.schema.json': StoredSourceSchema,
  'source_quota_status.schema.json': SourceQuotaStatusSchema,
  'quota_status.schema.json': QuotaStatusSchema,
  'quota_error.schema.json': QuotaErrorSchema,
  'user_source.schema.json': UserSourceSchema,
};

for (const [file, schema] of Object.entries(registry)) {
  const name = file.replace('.schema.json', '');
  const json = zodToJsonSchema(schema as never, { name, $refStrategy: 'none' });
  writeFileSync(join(outDir, file), JSON.stringify(json, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`wrote schema/${file}`);
}
