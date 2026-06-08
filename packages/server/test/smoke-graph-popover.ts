/**
 * Standalone smoke (run: `tsx --jitless`). vitest can't run in this toolchain, so this
 * drives the real public/client.js + public/graph.js through the mocked-DOM harness to
 * verify the knowledge-graph node popover: clicking a node opens a card listing the
 * transcript MESSAGES that concept refers to (resolved from the node's first mention,
 * its ConceptCard's mentions, and incident-edge evidence), clicking a message deep-dives
 * via the shared explain flow, and the popover closes on its ×, on Escape, on a
 * background click, and on a repeat tap of the same node. Exits non-zero on first fail.
 */
import assert from 'node:assert';
import { loadClient } from './dom-harness.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = loadClient();
await h.tick(); // let bootAccount's /api/session fetch settle

const sock = h.sockets[0]!;
assert(sock, 'a websocket was created at load');
sock.readyState = 1;
if (sock.onopen) sock.onopen();
const send = (frame: unknown) => sock.onmessage!({ data: JSON.stringify(frame) });

// Go live, then feed three transcript lines, two concept cards, and a kg_delta — the
// exact shapes the live-intel worker publishes (relayed to the browser as `envelope`).
send({ type: 'status', sessionId: 'sess-1', mode: 'live', providers: { stt: 'deepgram', llm: 'anthropic', search: 'tavily', auth: 'stub' } });

const seg = (id: string, who: string, text: string) =>
  send({ type: 'envelope', env: { segment_id: id, rev: 1, is_final: true, text, speaker: { display_name: who } } });
seg('seg_0', 'Alice', "Let's talk about RAG for the assistant.");
seg('seg_1', 'Bob', 'RAG pulls context from a vector database before answering.');
seg('seg_2', 'Alice', "We'll back it with pgvector.");

// RAG: first mentioned at seg_0, mentioned again at seg_1, with a transcript citation.
send({ type: 'envelope', env: { message_type: 'concept_card', card: { id: 'cc_live_1', revision: 1, state: 'enriched', surface_form: 'RAG', canonical_name: 'Retrieval-Augmented Generation', kind: 'acronym', definition_short: 'Retrieval plus generation.', salience: 0.8, first_mention: { segment_id: 'seg_0' }, mention_count: 2, mention_segment_ids: ['seg_0', 'seg_1'], sources: [{ citation_id: 'ct1', type: 'transcript', transcript_segment_ids: ['seg_1'] }] } } });
send({ type: 'envelope', env: { message_type: 'concept_card', card: { id: 'cc_live_2', revision: 1, state: 'enriched', surface_form: 'vector db', canonical_name: 'Vector Database', kind: 'concept', definition_short: 'Stores embeddings.', salience: 0.7, first_mention: { segment_id: 'seg_1' }, mention_count: 1, mention_segment_ids: ['seg_1'] } } });

// Graph: RAG → Vector Database (evidence seg_2), plus a node referencing a line we never
// received (seg_missing) to exercise the "nothing linked yet" empty state.
send({ type: 'envelope', env: { message_type: 'kg_delta', delta: { delta_seq: 1,
  upsert_nodes: [
    { id: 'kgn_live_1', label: 'Retrieval-Augmented Generation', node_type: 'concept', concept_card_id: 'cc_live_1', first_seen_segment_id: 'seg_0' },
    { id: 'kgn_live_2', label: 'Vector Database', node_type: 'entity', concept_card_id: 'cc_live_2', first_seen_segment_id: 'seg_1' },
    { id: 'kgn_live_3', label: 'Mystery Topic', node_type: 'topic', concept_card_id: null, first_seen_segment_id: 'seg_missing' },
  ],
  upsert_edges: [
    { id: 'kge_live_1', src: 'kgn_live_1', dst: 'kgn_live_2', relation: 'depends_on', directed: true, evidence_segment_ids: ['seg_2'] },
  ],
  remove_node_ids: [], remove_edge_ids: [] } } });

// renderGraph is rAF-coalesced → a setTimeout(16) in the vm; wait it out so graph.js
// has built the SVG node groups we click below.
await new Promise((r) => setTimeout(r, 60));

let failures = 0;
const check = (label: string, cond: boolean) => {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

const graphEl = h.byId('graph');
const svg = graphEl.childNodes[0];
const popover = () => graphEl.querySelector('.graph-popover');
const nodeGroups = (): any[] => (svg && svg.childNodes[1] ? svg.childNodes[1].children : []);
const findNode = (label: string): any => nodeGroups().find((g) => g.textContent.includes(label));

check('graph built an <svg> with three node groups', !!svg && nodeGroups().length === 3);
check('no popover before any click', !popover());

// --- click the RAG node → popover lists the messages it refers to -----------
const rag = findNode('Retrieval-Augmented Generation');
assert(rag, 'found the RAG node group');
rag.dispatch('click', { type: 'click' });

const pop = popover();
check('clicking a node opens a popover', !!pop);
check('popover title is the node label', !!pop && pop.textContent.includes('Retrieval-Augmented Generation'));
check('popover shows the node type chip', !!pop && pop.textContent.includes('concept'));
// seg_0 (first_seen + first_mention), seg_1 (mention + citation), seg_2 (edge evidence).
check('popover counts 3 referring messages', !!pop && pop.textContent.includes('3 messages'));
check('lists the seg_0 message', !!pop && pop.textContent.includes("Let's talk about RAG"));
check('lists the seg_1 message', !!pop && pop.textContent.includes('pulls context from a vector database'));
check('lists the edge-evidence (seg_2) message', !!pop && pop.textContent.includes('back it with pgvector'));

// --- clicking a message deep-dives via the explain flow + closes the popover -
const rows = pop ? pop.querySelectorAll('.gp-msg') : [];
check('a message row per referring message', rows.length === 3);
const sentBefore = sock.sent.length;
rows[0].dispatch('click', { type: 'click' });
const explainFrames = sock.sent
  .slice(sentBefore)
  .map((s: string) => JSON.parse(s))
  .filter((f: any) => f.type === 'explain' && f.segment_id === 'seg_0');
check('clicking a message sends exactly one explain frame for that segment', explainFrames.length === 1);
check('clicking a message renders the explanation panel', h.byId('explanation').textContent.includes("Let's talk about RAG"));
check('deep-diving closed the popover', !popover());

// --- a node with no received transcript lines → graceful empty state --------
const mystery = findNode('Mystery Topic');
mystery.dispatch('click', { type: 'click' });
const empty = popover();
check('an unlinked node still opens a popover', !!empty);
check('empty popover explains nothing is linked yet', !!empty && empty.textContent.includes('No transcript messages'));

// Re-tapping the same node refreshes the one popover in place (never a second host).
mystery.dispatch('click', { type: 'click' });
check('re-tapping the same node keeps exactly one popover', graphEl.querySelectorAll('.graph-popover').length === 1);

// Clicking a different node moves that single popover to it (no stray hosts).
findNode('Retrieval-Augmented Generation').dispatch('click', { type: 'click' });
check(
  'clicking another node moves the single popover to it',
  graphEl.querySelectorAll('.graph-popover').length === 1 && popover().textContent.includes('Retrieval-Augmented Generation'),
);

// --- close affordances: ×, Escape, background click ------------------------
const reopen = () => findNode('Vector Database').dispatch('click', { type: 'click' });

reopen();
const closeBtn = popover().querySelector('.gp-close');
check('popover has a close button', !!closeBtn);
closeBtn.dispatch('click', { type: 'click' });
check('the × closes the popover', !popover());

reopen();
check('reopened on another node', !!popover());
h.fireDoc('keydown', { key: 'Escape' });
check('Escape closes the popover', !popover());

reopen();
svg.dispatch('click', { target: svg });
check('a background (empty-canvas) click closes the popover', !popover());

// --- removing the open popover's node via a kg_delta dismisses it ------------
reopen();
check('reopened before removal', !!popover());
send({ type: 'envelope', env: { message_type: 'kg_delta', delta: { delta_seq: 2, upsert_nodes: [], upsert_edges: [], remove_node_ids: ['kgn_live_2'], remove_edge_ids: ['kge_live_1'] } } });
await new Promise((r) => setTimeout(r, 60));
check('removing the popover node closes the popover', !popover());

// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
