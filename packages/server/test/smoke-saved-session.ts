/**
 * Standalone smoke (tsx --jitless): drives the real client.js through the mocked-DOM
 * harness to open a saved session whose stored artifacts include the live
 * intelligence (concepts / insights / recap), and asserts the read-only saved view
 * renders them plus a Markdown export button. Verifies Phase 4 persistence rendering.
 */
import assert from 'node:assert';
import { loadClient } from './dom-harness.js';

function backend() {
  const sessions = [{ id: 's-2', title: 'Pricing sync', artifact_count: 4, consent_class: 'standard', created_at_us: 2_000_000 }];
  const quota = () => ({ tier: 'free', used: 1, limit: 5, retention_window_days: 7, exceeded: false });
  return (url: string, init?: any) => {
    const method = (init && init.method) || 'GET';
    if (url === '/api/sessions' && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ sessions: sessions.slice(), quota: quota() }) };
    }
    if (url.startsWith('/api/sessions/') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          session: sessions[0],
          artifacts: [
            { kind: 'transcript_segment', payload: { who: 'Alice', text: 'We should adopt RAG.' } },
            { kind: 'concept_card', payload: { id: 'cc1', canonical_name: 'Retrieval-Augmented Generation', kind: 'acronym', definition_short: 'Retrieval plus generation.' } },
            { kind: 'insight_item', payload: { id: 'i1', insight_type: 'action_item', text: 'Adopt pgvector', status: 'open' } },
            { kind: 'session_summary', payload: { text: 'The team weighed RAG.', bullets: ['RAG chosen'] } },
          ],
        }),
      };
    }
    if (url.startsWith('/api/session')) {
      return { ok: true, status: 200, json: async () => ({ authenticated: true, account: { id: 'a', tier: 'free', display_name: 'Ada' }, identity: { provider: 'google', email: 'a@x', display_name: 'Ada' }, quota: quota(), providers: ['google'], authMode: 'real' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

const h = loadClient({ fetch: backend() });
await h.tick();
h.nav.history.dispatch('click', { preventDefault() {} });
await h.tick();
await h.tick();
const open = h.byId('modal-body').querySelector('.hist-open');
assert(open, 'the saved session has an Open button');
open.dispatch('click', {});
await h.tick();
await h.tick();

const body = h.byId('modal-body');
let failures = 0;
const check = (label: string, cond: boolean) => {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

check('recap paragraph rendered', body.textContent.includes('The team weighed RAG.'));
check('concept rendered', body.textContent.includes('Retrieval-Augmented Generation'));
check('insight rendered', body.textContent.includes('Adopt pgvector'));
check('transcript line rendered', body.textContent.includes('We should adopt RAG.'));
check('export button present', !!body.querySelector('.hist-export'));

// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
