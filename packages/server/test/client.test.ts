import { describe, it, expect } from 'vitest';
import { loadClient } from './dom-harness.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * UI behaviour tests for `public/client.js`, run headlessly via the mocked-DOM vm
 * harness. Covers the two new features:
 *   F1 — typing a follow-up sends exactly one `ask` frame and renders the reply.
 *   F2 — pop-out reparents the panels into a PiP window and restores them on close,
 *        and degrades to window.open when Document PiP is absent.
 */

/** Drive the socket to a live session with one explained question segment. */
function liveWithExplained(h: ReturnType<typeof loadClient>) {
  const ws = h.sockets[0]!;
  ws.readyState = 1;
  if (ws.onopen) ws.onopen();
  ws.onmessage!({
    data: JSON.stringify({
      type: 'status',
      mode: 'live',
      providers: { stt: 'deepgram', llm: 'anthropic', search: 'tavily' },
    }),
  });
  ws.onmessage!({
    data: JSON.stringify({
      type: 'envelope',
      env: { segment_id: 's1', rev: 1, is_final: true, text: 'What is ARR?', speaker: { display_name: 'Alice' } },
    }),
  });
  ws.onmessage!({
    data: JSON.stringify({
      type: 'explanation',
      explanation: {
        segment_id: 's1',
        sentence: 'What is ARR?',
        explanation: 'Asks about ARR.',
        breakdown: [],
        is_question: true,
        answer: 'Annual recurring revenue.',
        sources: [{ url: 'https://x/arr', title: 'Investopedia' }],
        state: 'ok',
      },
    }),
  });
  return ws;
}

describe('F1 — type a follow-up question', () => {
  it('keeps the follow-up input disabled until a sentence has been explained', () => {
    const h = loadClient();
    expect(h.byId('followup-input').disabled).toBe(true);

    const ws = h.sockets[0]!;
    ws.readyState = 1;
    ws.onmessage!({
      data: JSON.stringify({ type: 'status', mode: 'live', providers: { stt: 'deepgram', llm: 'anthropic', search: 'tavily' } }),
    });
    // still nothing explained → still disabled
    expect(h.byId('followup-input').disabled).toBe(true);
  });

  it('submitting the form sends exactly one ask frame and renders the answer + sources', () => {
    const h = loadClient();
    const ws = liveWithExplained(h);

    expect(h.byId('followup-input').disabled).toBe(false);

    h.byId('followup-input').value = 'give me a simpler explanation';
    h.byId('followup').dispatch('submit', { preventDefault() {} });

    // Exactly one `ask` frame (the auto-explain frame is a separate type).
    const asks = ws.sent.map((s) => JSON.parse(s)).filter((m: any) => m.type === 'ask');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ type: 'ask', segment_id: 's1', question: 'give me a simpler explanation' });
    expect(typeof asks[0].ask_id).toBe('string');
    // The ask ships the conversation context from the client's own model, so the
    // answer survives a WS reconnect (a fresh server session has no buffer yet).
    expect(asks[0].sentence).toBe('What is ARR?');
    expect(asks[0].transcript).toContain('What is ARR?');

    // The question shows immediately in the thread; input is cleared.
    expect(h.byId('followup-thread').textContent).toContain('give me a simpler explanation');
    expect(h.byId('followup-input').value).toBe('');

    // Server replies with the grounded answer → rendered with a source link.
    ws.onmessage!({
      data: JSON.stringify({
        type: 'answer',
        ask_id: asks[0].ask_id,
        answer: {
          id: 'fu_s1',
          session_id: 'sess',
          tenant_id: 'ten',
          segment_id: 's1',
          question: 'give me a simpler explanation',
          answer: 'ARR is the revenue you expect to recur every year.',
          sources: [{ citation_id: 'c1', type: 'web', url: 'https://y/arr', title: 'Source Y' }],
          state: 'ok',
        },
      }),
    });

    const thread = h.byId('followup-thread');
    expect(thread.textContent).toContain('ARR is the revenue you expect to recur every year.');
    const links = thread.querySelectorAll('a');
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links.some((a: any) => a.href === 'https://y/arr')).toBe(true);
  });

  it('renders a degraded answer gracefully (no answer, no throw)', () => {
    const h = loadClient();
    const ws = liveWithExplained(h);
    h.byId('followup-input').value = 'what did he mean?';
    h.byId('followup').dispatch('submit', { preventDefault() {} });
    const ask = ws.sent.map((s) => JSON.parse(s)).find((m: any) => m.type === 'ask');

    ws.onmessage!({
      data: JSON.stringify({
        type: 'answer',
        ask_id: ask.ask_id,
        answer: {
          id: 'fu_s1',
          session_id: 'sess',
          tenant_id: 'ten',
          segment_id: 's1',
          question: 'what did he mean?',
          answer: null,
          sources: [],
          state: 'degraded',
        },
      }),
    });

    const thread = h.byId('followup-thread');
    expect(thread.textContent).toContain('No confident answer found.');
    expect(thread.textContent).toContain('Demo/degraded');
  });

  it('renders an answer_error without wedging', () => {
    const h = loadClient();
    const ws = liveWithExplained(h);
    h.byId('followup-input').value = 'why?';
    h.byId('followup').dispatch('submit', { preventDefault() {} });
    const ask = ws.sent.map((s) => JSON.parse(s)).find((m: any) => m.type === 'ask');

    ws.onmessage!({ data: JSON.stringify({ type: 'answer_error', ask_id: ask.ask_id, message: 'boom' }) });
    expect(h.byId('followup-thread').textContent).toContain('Could not answer: boom');
  });

  it('fails an in-flight follow-up when the socket drops (no stuck "Answering…")', () => {
    const h = loadClient();
    const ws = liveWithExplained(h);
    h.byId('followup-input').value = 'what did he mean?';
    h.byId('followup').dispatch('submit', { preventDefault() {} });

    // The thread shows the pending state until the socket drops.
    expect(h.byId('followup-thread').textContent).toContain('Answering…');

    // Socket drops before the answer arrives → the pending follow-up is failed, not
    // left spinning forever.
    ws.close();
    const thread = h.byId('followup-thread').textContent;
    expect(thread).not.toContain('Answering…');
    expect(thread).toContain('Connection dropped');
  });
});

describe('F2 — pop out into a floating window', () => {
  it('moves the panels into the PiP window, copies styles, and restores on close', async () => {
    const h = loadClient();
    const pip = h.makePipWindow();
    (h.window as any).documentPictureInPicture = { requestWindow: async () => pip };

    const grid = h.grid;
    // sanity: panels start in the content grid
    expect(h.byId('card-transcript').parentNode).toBe(grid);

    await h.byId('popout')._listeners.click[0]({});

    // Stylesheets cloned into the PiP head.
    expect(pip.document.head.children.length).toBeGreaterThanOrEqual(1);
    // Panels moved (not cloned) under the PiP body, which got the compact class.
    expect(h.byId('card-transcript').parentNode).toBe(pip.document.body);
    expect(h.byId('card-explanation').parentNode).toBe(pip.document.body);
    expect(pip.document.body.classList.contains('pip-body')).toBe(true);
    expect(h.byId('popout').querySelector('.btn-txt').textContent).toBe('Return');

    // Closing the PiP window reparents the panels back, intact and in order.
    pip.close();
    expect(h.byId('card-transcript').parentNode).toBe(grid);
    expect(h.byId('card-explanation').parentNode).toBe(grid);
    expect(grid.children[0]).toBe(h.byId('card-transcript'));
    expect(grid.children[1]).toBe(h.byId('card-explanation'));
    expect(h.byId('popout').querySelector('.btn-txt').textContent).toBe('Pop out');
  });

  it('falls back to window.open (no throw) when Document PiP is unavailable', () => {
    const h = loadClient(); // no documentPictureInPicture on the mocked window
    expect('documentPictureInPicture' in (h.window as any)).toBe(false);

    h.byId('popout').dispatch('click', {});

    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]![0]).toBe('http://localhost:5173/');
    // Panels are untouched on the fallback path.
    expect(h.byId('card-transcript').parentNode).toBe(h.grid);
  });
});

describe('Theme — light default with a persistent dark toggle', () => {
  it('defaults to light (no data-theme attribute) and shows the toggle in its light state', () => {
    const h = loadClient();
    // Light is the absence of the attribute (the head script only sets it for dark/light choices).
    expect(h.document.documentElement.getAttribute('data-theme')).toBe(null);
    const btn = h.byId('theme-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Switch to dark mode');
  });

  it('clicking the toggle flips to dark, persists it, and updates the button a11y state', () => {
    const h = loadClient();
    const btn = h.byId('theme-toggle');

    btn.dispatch('click', {});
    expect(h.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(h.storage['aizen-theme']).toBe('dark');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Switch to light mode');

    // Clicking again returns to light and persists that choice too.
    btn.dispatch('click', {});
    expect(h.document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(h.storage['aizen-theme']).toBe('light');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Switch to dark mode');
  });

  it('honors a previously stored dark choice on load', () => {
    const h = loadClient({ initialTheme: 'dark' });
    expect(h.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(h.byId('theme-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(h.byId('theme-toggle').title).toBe('Switch to light mode');
  });

  it('mirrors the active theme into the pop-out window so it does not render light', async () => {
    const h = loadClient({ initialTheme: 'dark' });
    const pip = h.makePipWindow();
    (h.window as any).documentPictureInPicture = { requestWindow: async () => pip };

    await h.byId('popout')._listeners.click[0]({});
    expect(pip.document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
