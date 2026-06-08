/**
 * Regression smoke (run: `tsx --jitless`) for the Insights "evidence" chip.
 *
 * An insight's evidence chip deep-dives into the transcript line that supports it.
 * It used to closeModal() first — which dropped the breakdown into the dashboard's
 * explanation card, almost always scrolled off-screen, so clicking it looked dead.
 * The chip now SWAPS the open focus popup to the Explanation view, so the deep-dive
 * lands front-and-centre. This drives the real client.js through the mocked DOM and
 * asserts that flow end-to-end. Exits non-zero on the first failure.
 */
import { loadClient } from './dom-harness.js';

const h = loadClient();
await h.tick(); // let bootAccount's /api/session settle

const sock = h.sockets[0]!;
sock.readyState = 1;
if (sock.onopen) sock.onopen();
const send = (frame: unknown) => sock.onmessage!({ data: JSON.stringify(frame) });

send({ type: 'status', mode: 'live', providers: { stt: 'deepgram', llm: 'anthropic', search: 'tavily' } });
// A REAL final transcript segment (not a question → no auto-explain) keyed seg_1, then
// an insight whose evidence points at it — the shapes the live-intel worker publishes.
send({ type: 'envelope', env: { segment_id: 'seg_1', rev: 1, is_final: true, speaker: { display_name: 'Alice' }, text: 'We will adopt pgvector for the store.' } });
send({ type: 'envelope', env: { message_type: 'insight_item', insight: { id: 'ins_1', revision: 1, insight_type: 'action_item', status: 'open', text: 'Evaluate pgvector', owner_speaker_id: 'Alice', evidence_segment_ids: ['seg_1'] } } });

await new Promise((r) => setTimeout(r, 50)); // renders are rAF-coalesced (setTimeout in the vm)

let failures = 0;
const check = (label: string, cond: boolean): void => {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

const insights = h.byId('insights');
const chip = insights.querySelector('button.ii-jump');
check('evidence chip renders when its segment is in the transcript', !!chip);
check('chip is labelled "evidence"', !!chip && chip.textContent === 'evidence');

// Open the Insights focus popup (relocates #card-insights into the modal body).
const insightsNav = h.document.querySelectorAll('.nav-item').find((n: any) => n.getAttribute('data-modal') === 'insights');
insightsNav.dispatch('click', { preventDefault() {}, type: 'click' });
const overlay = h.byId('modal-overlay');
check('Insights popup opened', overlay.hidden === false && h.byId('modal-title').textContent === 'Insights');

const chipInModal = h.byId('modal-body').querySelector('button.ii-jump');
check('evidence chip relocated into the popup', !!chipInModal);

// Click it: the deep-dive should SWAP the popup to the Explanation view (not close it).
const sentBefore = sock.sent.length;
chipInModal.dispatch('click', { type: 'click' });
await new Promise((r) => setTimeout(r, 20));

check('popup STAYS open after clicking evidence', overlay.hidden === false);
check('popup now shows the Explanation view', h.byId('modal-title').textContent === 'Explanation');
check('the supporting sentence is visible in the popup', h.byId('modal-body').textContent.includes('We will adopt pgvector for the store.'));
const frames = sock.sent.slice(sentBefore).map((s) => JSON.parse(s));
check('an explain request was sent for that segment', frames.some((f) => f.type === 'explain' && f.segment_id === 'seg_1'));

// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
