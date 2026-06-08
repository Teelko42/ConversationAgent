/**
 * Standalone smoke for `runLiveIntel` (run: `tsx --jitless` from the repo root).
 * vitest can't run in this toolchain, so this exercises the live-intel worker
 * end-to-end against a FAKE gateway + the real in-memory bus:
 *   - feeds final transcript lines onto the bus,
 *   - asserts concept_card / insight_item / kg_delta / session_summary envelopes
 *     are published,
 *   - asserts a repeated concept is DE-DUPED (revision bumped, same id, no new node).
 * Exits non-zero on the first failed assertion.
 */
import { InMemorySessionBus } from '@aizen/edge-gateway';
// Relative import: a package is not a dependency of itself, so '@aizen/intel-worker'
// is not resolvable from inside it — go straight to the source (tsx maps .js→.ts).
import { runLiveIntel } from '../src/live-intel.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

const EXTRACT_JSON = JSON.stringify({
  concepts: [
    { surface_form: 'RAG', canonical_name: 'Retrieval-Augmented Generation', kind: 'acronym', definition_short: 'Combining retrieval with generation.', salience: 0.8, segment_id: 0 },
    { surface_form: 'vector database', canonical_name: 'Vector Database', kind: 'concept', definition_short: 'Stores embeddings for similarity search.', salience: 0.7, segment_id: 1 },
  ],
  insights: [{ type: 'action_item', text: 'Evaluate pgvector for the store', owner: 'Alice', evidence_segment_ids: [1] }],
  edges: [{ from: 'Retrieval-Augmented Generation', to: 'Vector Database', relation: 'depends_on' }],
});
const SUMMARY_JSON = JSON.stringify({
  paragraph: 'They discussed RAG and vector databases.',
  bullets: ['RAG combines retrieval and generation', 'Considering pgvector'],
});

// Minimal fake gateway: returns canned JSON per call kind. `ok:true`, non-stub text.
const fakeGateway = {
  invoke: async (task: { kind: string }) => ({
    ok: true as const,
    tier: 'haiku' as const,
    text: task.kind === 'summarize' ? SUMMARY_JSON : EXTRACT_JSON,
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd: 0,
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const bus = new InMemorySessionBus();

// Collect every published F02 envelope by message_type.
const got: Record<string, any[]> = { concept_card: [], insight_item: [], kg_delta: [], session_summary: [] };

const worker = runLiveIntel(SESSION, bus, fakeGateway, {
  tenantId: TENANT,
  consent: { consent_class: 'standard', pii_present: false },
  minNewFinals: 2,
  minIntervalMs: 0,
  idleMs: 50,
  summaryEveryN: 2,
  summaryIntervalMs: 1000,
});

bus.subscribe(SESSION, 0, (env: any) => {
  if (env && typeof env.message_type === 'string' && got[env.message_type]) got[env.message_type].push(env);
});

let f01 = 0;
function feed(text: string, who: string): void {
  const seq = bus.nextSeq(SESSION, 'f01');
  bus.publish(SESSION, {
    schema_version: '1.0.0',
    tenant_id: TENANT,
    session_id: SESSION,
    seq,
    producer_id: 'smoke',
    emitted_at: 0,
    segment_id: `seg_${seq}`,
    text,
    is_final: true,
    speaker: { display_name: who },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, cond: boolean): void {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
}

async function main(): Promise<void> {
  // Phase 1: two finals → triggers one extraction + one summary.
  feed('Let us talk about RAG and how it grounds answers.', 'Alice');
  feed('We will need a vector database to store embeddings.', 'Bob');
  await worker.drain();
  await sleep(10);
  await worker.drain();

  check('concept_card published (>=2)', got.concept_card.length >= 2);
  check('insight_item published (>=1)', got.insight_item.length >= 1);
  check('kg_delta published (>=1)', got.kg_delta.length >= 1);
  const firstDelta = got.kg_delta[0];
  check('kg_delta has 2 nodes', !!firstDelta && firstDelta.delta.upsert_nodes.length === 2);
  check('kg_delta has 1 edge', !!firstDelta && firstDelta.delta.upsert_edges.length === 1);
  check('session_summary published (>=1)', got.session_summary.length >= 1);
  check(
    'summary carries bullets',
    got.session_summary.length > 0 && got.session_summary[0].summary.bullets.length === 2,
  );

  const ragV1 = got.concept_card.find(
    (e) => e.card.canonical_name === 'Retrieval-Augmented Generation' && e.card.revision === 1,
  );
  check('RAG card emitted at revision 1', !!ragV1);
  check('RAG card is an acronym', !!ragV1 && ragV1.card.kind === 'acronym');
  check('insight is an action_item', got.insight_item[0]?.insight.insight_type === 'action_item');
  check('insight has >=1 evidence', (got.insight_item[0]?.insight.evidence_segment_ids?.length ?? 0) >= 1);

  // Phase 2: two more finals → second extraction returns the SAME concepts → de-dup.
  const cardsBefore = got.concept_card.length;
  const deltasBefore = got.kg_delta.length;
  feed('Back to RAG — the retrieval step matters most.', 'Alice');
  feed('Right, and the vector database choice affects recall.', 'Bob');
  await worker.drain();
  await sleep(10);
  await worker.drain();

  const ragV2 = got.concept_card.find(
    (e) => e.card.canonical_name === 'Retrieval-Augmented Generation' && e.card.revision === 2,
  );
  check('RAG re-surfaced at revision 2 (deduped, same id)', !!ragV2 && ragV2.card.id === ragV1!.card.id);
  check('second extraction produced more concept_card revisions', got.concept_card.length > cardsBefore);
  check(
    'no duplicate KG node for a repeated concept (no new kg_delta from dedup-only round)',
    got.kg_delta.length === deltasBefore,
  );

  worker.stop();
  await worker.drain();

  // eslint-disable-next-line no-console
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
