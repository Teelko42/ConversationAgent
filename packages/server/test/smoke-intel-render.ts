/**
 * Standalone render smoke (run: `tsx --jitless`). vitest can't run in this toolchain,
 * so this drives the real `public/client.js` through the mocked-DOM harness, feeds it
 * the F02 envelopes the live-intel worker emits, and asserts the new intelligence
 * panels (concepts / insights / recap) render. Exits non-zero on the first failure.
 */
import assert from 'node:assert';
import { loadClient } from './dom-harness.js';

const h = loadClient();
await h.tick(); // let bootAccount's /api/session fetch settle

const sock = h.sockets[0];
assert(sock, 'a websocket was created at load');
sock.readyState = 1;
if (sock.onopen) sock.onopen();

const send = (frame: unknown) => sock.onmessage!({ data: JSON.stringify(frame) });

// Go live with the real LLM (so the UI is in its normal live state).
send({
  type: 'status',
  sessionId: 'sess-1',
  mode: 'live',
  providers: { stt: 'deepgram', llm: 'anthropic', search: 'tavily', auth: 'stub' },
});

// Two concept cards, one insight, a kg_delta, and a recap — exactly the shapes the
// live-intel worker publishes onto the bus (relayed to the browser as `envelope`).
send({ type: 'envelope', env: { message_type: 'concept_card', card: { id: 'cc_live_1', revision: 1, state: 'enriched', surface_form: 'RAG', canonical_name: 'Retrieval-Augmented Generation', kind: 'acronym', definition_short: 'Retrieval plus generation.', salience: 0.8, first_mention: { segment_id: 'seg_0' }, mention_count: 1 } } });
send({ type: 'envelope', env: { message_type: 'concept_card', card: { id: 'cc_live_2', revision: 1, state: 'enriched', surface_form: 'vector db', canonical_name: 'Vector Database', kind: 'concept', definition_short: 'Stores embeddings.', salience: 0.7, first_mention: { segment_id: 'seg_1' }, mention_count: 1 } } });
send({ type: 'envelope', env: { message_type: 'insight_item', insight: { id: 'ins_live_1', revision: 1, insight_type: 'action_item', status: 'open', text: 'Evaluate pgvector for the store', owner_speaker_id: 'Alice', evidence_segment_ids: ['seg_1'] } } });
send({ type: 'envelope', env: { message_type: 'kg_delta', delta: { delta_seq: 1, upsert_nodes: [{ id: 'kgn_live_1', label: 'Retrieval-Augmented Generation', node_type: 'concept', concept_card_id: 'cc_live_1', first_seen_segment_id: 'seg_0' }, { id: 'kgn_live_2', label: 'Vector Database', node_type: 'concept', concept_card_id: 'cc_live_2', first_seen_segment_id: 'seg_1' }], upsert_edges: [{ id: 'kge_live_1', src: 'kgn_live_1', dst: 'kgn_live_2', relation: 'depends_on', directed: true }], remove_node_ids: [], remove_edge_ids: [] } } });
send({ type: 'envelope', env: { message_type: 'session_summary', summary: { text: 'They discussed RAG and vector databases.', bullets: ['RAG combines retrieval and generation', 'Considering pgvector'], updated_at_us: 1_700_000_000_000_000 } } });

// Re-surface RAG at a higher revision → must fold in place (no duplicate card).
send({ type: 'envelope', env: { message_type: 'concept_card', card: { id: 'cc_live_1', revision: 2, state: 'enriched', surface_form: 'RAG', canonical_name: 'Retrieval-Augmented Generation', kind: 'acronym', definition_short: 'Retrieval plus generation, refined.', salience: 0.85, first_mention: { segment_id: 'seg_0' }, mention_count: 2 } } });

// Renders are rAF-coalesced → a setTimeout(16) in the vm; wait it out.
await new Promise((r) => setTimeout(r, 50));

let failures = 0;
const check = (label: string, cond: boolean) => {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

const concepts = h.byId('concepts');
const insights = h.byId('insights');
const summary = h.byId('summary');

check('two concept cards rendered (deduped)', concepts.children.length === 2);
check('concepts count badge = 2', h.byId('concepts-count').textContent === '2');
check('concept card shows the canonical name', concepts.textContent.includes('Retrieval-Augmented Generation'));
check('refined revision folded in place', concepts.textContent.includes('refined'));
check('insights rendered', insights.children.length >= 1);
check('insight text present', insights.textContent.includes('Evaluate pgvector'));
check('insights count badge = 1', h.byId('insights-count').textContent === '1');
check('recap paragraph rendered', summary.textContent.includes('vector databases'));
check('recap bullet rendered', summary.textContent.includes('pgvector'));

// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
