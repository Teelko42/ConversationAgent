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

describe('Explanation tab — auto-scroll keeps fresh content in view', () => {
  it('scrolls the breakdown panel to the top when a sentence is explained', () => {
    const h = loadClient();
    liveWithExplained(h);

    // Nothing scrolled yet — the explanation arrived but no sentence is selected.
    expect((h.byId('explanation') as any)._scrolledTo).toBeUndefined();

    // Click the finalized sentence → its full breakdown renders in the panel,
    // which scrolls back to the top so it starts at the sentence.
    const line = h.byId('transcript').children[0]!;
    h.byId('transcript').dispatch('click', { target: line });

    expect((h.byId('explanation') as any)._scrolledTo).toEqual({ top: 0, behavior: 'smooth' });
  });

  it('scrolls the newest follow-up into view when its answer arrives', () => {
    const h = loadClient();
    const ws = liveWithExplained(h);

    h.byId('followup-input').value = 'simpler please';
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
          question: 'simpler please',
          answer: 'Yearly recurring revenue.',
          sources: [],
          state: 'ok',
        },
      }),
    });

    const thread = h.byId('followup-thread');
    const latest = thread.children[thread.children.length - 1] as any;
    expect(latest._scrolledIntoView).toEqual({ behavior: 'smooth', block: 'nearest' });
  });
});

describe('Transcript — auto-scroll follows the live tail as it fills', () => {
  /** Bring the socket to a live session (buttons enabled, ready for envelopes). */
  function liveSession(h: ReturnType<typeof loadClient>) {
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
    return ws;
  }

  function sendLine(ws: any, id: string, text: string, isFinal = true) {
    ws.onmessage!({
      data: JSON.stringify({ type: 'envelope', env: { segment_id: id, rev: 1, is_final: isFinal, text } }),
    });
  }

  it('snaps the transcript to the bottom when a new line arrives and the reader is at the tail', () => {
    const h = loadClient();
    const ws = liveSession(h);
    const transcript = h.byId('transcript') as any;

    // An overflowing box with the reader pinned to the bottom (500 - 300 - 200 = 0).
    transcript.scrollHeight = 500;
    transcript.clientHeight = 200;
    transcript.scrollTop = 300;
    transcript._scrolledTo = undefined;

    sendLine(ws, 's1', 'first line of the conversation');

    // Followed the tail: snapped to the very bottom (top === scrollHeight), instantly.
    expect(transcript._scrolledTo).toEqual({ top: 500, behavior: 'auto' });
    expect(transcript.textContent).toContain('first line of the conversation');
  });

  it('does NOT re-pin when the reader has scrolled up to re-read earlier lines', () => {
    const h = loadClient();
    const ws = liveSession(h);
    const transcript = h.byId('transcript') as any;

    // First line renders while the reader is at the tail (this one does follow).
    sendLine(ws, 's1', 'first line');

    // Reader scrolls up — now far from the bottom (1000 - 0 - 200 = 800 ≫ slack).
    transcript.scrollHeight = 1000;
    transcript.clientHeight = 200;
    transcript.scrollTop = 0;
    transcript._scrolledTo = undefined;

    // A new line arrives: it must render, but must NOT yank the reader to the bottom.
    sendLine(ws, 's2', 'second line');

    expect(transcript._scrolledTo).toBeUndefined();
    expect(transcript.textContent).toContain('second line');
  });
});

describe('Account — sign in / out · identity + tier · quota usage', () => {
  /** A /api/session responder for a signed-in account at the given quota. */
  const sessionResponder = (over: Record<string, unknown> = {}): any => (url: string) => {
    if (url.startsWith('/api/session')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          authenticated: true,
          account: { id: 'acc-1', tier: 'free', display_name: 'Ada Lovelace' },
          identity: { provider: 'google', email: 'ada@example.com', display_name: 'Ada Lovelace' },
          quota: { tier: 'free', used: 2, limit: 5, retention_window_days: 7, exceeded: false },
          providers: ['google', 'microsoft'],
          authMode: 'real',
          ...over,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  it('shows the sign-in menu when anonymous (default fetch), listing providers', async () => {
    const h = loadClient(); // default fetch → anonymous, providers:['stub']
    await h.tick();
    expect(h.byId('acct-signin').hidden).toBe(false);
    expect(h.byId('acct-user').hidden).toBe(true);
    const menuBtns = h.byId('acct-menu').querySelectorAll('button');
    expect(menuBtns).toHaveLength(1);
    expect(menuBtns[0]!.textContent).toContain('demo account');
  });

  it('navigates to the provider login route when a sign-in option is clicked', async () => {
    const h = loadClient({
      fetch: (url: string) =>
        url.startsWith('/api/session')
          ? { ok: true, status: 200, json: async () => ({ authenticated: false, providers: ['google', 'microsoft'], authMode: 'real' }) }
          : { ok: true, status: 200, json: async () => ({}) },
    });
    await h.tick();
    const menuBtns = h.byId('acct-menu').querySelectorAll('button');
    expect(menuBtns).toHaveLength(2);
    menuBtns[0]!.dispatch('click', {});
    expect(h.location.href).toBe('/auth/google/login');
  });

  it('renders the signed-in identity, tier chip, and quota meter', async () => {
    const h = loadClient({ fetch: sessionResponder() });
    await h.tick();
    expect(h.byId('acct-user').hidden).toBe(false);
    expect(h.byId('acct-signin').hidden).toBe(true);
    expect(h.byId('acct-name').textContent).toBe('Ada Lovelace');
    expect(h.byId('acct-tier').textContent).toBe('FREE');
    expect(h.byId('acct-avatar').textContent).toBe('AL');
    expect(h.byId('acct-email').textContent).toBe('ada@example.com');
    expect(h.byId('quota-text').textContent).toBe('2 of 5');
    expect(h.byId('quota-fill').style.width).toBe('40%');
    expect(h.byId('quota-over').hidden).toBe(true);
  });

  it('saves the current session and updates the quota on success', async () => {
    const h = loadClient({ fetch: sessionResponder() });
    await h.tick();

    // Drive a live session with one final transcript line (gives a session id + artifact).
    const ws = h.sockets[0]!;
    ws.readyState = 1;
    ws.onmessage!({
      data: JSON.stringify({ type: 'status', sessionId: 'sess-uuid', mode: 'live', providers: { stt: 'deepgram', llm: 'anthropic', search: 'tavily' } }),
    });
    ws.onmessage!({
      data: JSON.stringify({ type: 'envelope', env: { segment_id: 's1', rev: 1, is_final: true, text: 'Quarterly numbers', speaker: { display_name: 'Bob' } } }),
    });

    // POST /api/sessions → 201 with an updated quota.
    h.setFetch((url: string) =>
      url === '/api/sessions'
        ? { ok: true, status: 201, json: async () => ({ saved: { id: 'sess-uuid' }, quota: { tier: 'free', used: 3, limit: 5, exceeded: false } }) }
        : { ok: true, status: 200, json: async () => ({}) },
    );

    h.byId('save-session-btn').dispatch('click', {});
    await h.tick();

    const post = h.fetchCalls.find((c) => c.url === '/api/sessions');
    expect(post).toBeTruthy();
    const body = JSON.parse((post!.init as any).body);
    expect(body.session_id).toBe('sess-uuid');
    expect(body.title).toBe('Quarterly numbers');
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({ kind: 'transcript_segment', id: 's1' });
    // quota meter advanced to 3 of 5.
    expect(h.byId('quota-text').textContent).toBe('3 of 5');
  });

  it('shows the typed over-quota state when a save is rejected (409)', async () => {
    const h = loadClient({ fetch: sessionResponder({ quota: { tier: 'free', used: 5, limit: 5, retention_window_days: 7, exceeded: true } }) });
    await h.tick();
    // boot already shows the exceeded state.
    expect(h.byId('quota-over').hidden).toBe(false);

    const ws = h.sockets[0]!;
    ws.readyState = 1;
    ws.onmessage!({ data: JSON.stringify({ type: 'status', sessionId: 'sess-uuid', mode: 'live', providers: {} }) });

    h.setFetch((url: string) =>
      url === '/api/sessions'
        ? { ok: false, status: 409, json: async () => ({ error: 'quota_exceeded', tier: 'free', used: 5, limit: 5, message: 'Resource quota reached for the free tier: 5 of 5 saved sessions used.', remedy: 'Delete a saved session to free a slot, or upgrade your plan for a higher cap.' }) }
        : { ok: true, status: 200, json: async () => ({}) },
    );

    h.byId('save-session-btn').dispatch('click', {});
    await h.tick();

    expect(h.byId('quota').classList.contains('over')).toBe(true);
    expect(h.byId('acct-msg').textContent).toContain('quota reached');
    expect(h.byId('acct-msg').textContent).toContain('Delete a saved session');
  });

  it('signs out and returns to the anonymous state', async () => {
    const h = loadClient({ fetch: sessionResponder() });
    await h.tick();
    expect(h.byId('acct-user').hidden).toBe(false);

    // After logout, /api/session reports anonymous again.
    h.setFetch((url: string) =>
      url === '/auth/logout'
        ? { ok: true, status: 200, json: async () => ({ ok: true }) }
        : { ok: true, status: 200, json: async () => ({ authenticated: false, providers: ['stub'], authMode: 'stub' }) },
    );

    h.byId('signout-btn').dispatch('click', {});
    await h.tick();
    await h.tick();

    expect(h.fetchCalls.some((c) => c.url === '/auth/logout')).toBe(true);
    expect(h.byId('acct-signin').hidden).toBe(false);
    expect(h.byId('acct-user').hidden).toBe(true);
  });
});

describe('Providers & Settings popups (sidebar tabs)', () => {
  const PLANS = [
    { tier: 'free', max_resources: 5, retention_window_days: 7, model_tier_cap: 'haiku', notes: '' },
    { tier: 'pro', max_resources: 200, retention_window_days: 360, model_tier_cap: 'opus', notes: '' },
    { tier: 'team', max_resources: 1000, retention_window_days: 365, model_tier_cap: 'opus', notes: '' },
    { tier: 'enterprise', max_resources: null, retention_window_days: null, model_tier_cap: 'opus', notes: '' },
  ];

  /** /api/session responder with provider_status + plans (and optional account). */
  const sessionWith = (over: Record<string, unknown> = {}): any => (url: string) => {
    if (url.startsWith('/api/session')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          authenticated: false,
          providers: ['google', 'microsoft'],
          authMode: 'real',
          provider_status: { stt: 'deepgram', llm: 'anthropic', search: 'tavily', auth: 'google+microsoft' },
          plans: PLANS,
          ...over,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  it('the status line shows just LIVE/DEMO — no provider breakdown', () => {
    const h = loadClient();
    const ws = h.sockets[0]!;
    ws.readyState = 1;
    ws.onmessage!({
      data: JSON.stringify({ type: 'status', mode: 'live', providers: { stt: 'deepgram', llm: 'anthropic', search: 'tavily', auth: 'stub' } }),
    });
    const status = h.byId('status').textContent;
    expect(status).toContain('LIVE');
    expect(status).not.toContain('stt');
    expect(status).not.toContain('explanations');
    expect(status).not.toContain('search');
  });

  it('clicking the Providers tab opens a popup with provider status + quota limits', async () => {
    const h = loadClient({ fetch: sessionWith() });
    await h.tick();
    expect(h.byId('modal-overlay').hidden).toBe(true);

    h.nav.providers.dispatch('click', { preventDefault() {} });

    expect(h.byId('modal-overlay').hidden).toBe(false);
    expect(h.byId('modal-title').textContent).toContain('Providers');
    const body = h.byId('modal-body').textContent;
    // active providers named
    expect(body).toContain('Deepgram');
    expect(body).toContain('Anthropic');
    expect(body).toContain('Tavily');
    // quota-limits table values
    expect(body).toContain('Free');
    expect(body).toContain('5');
    expect(body).toContain('200');
    expect(body).toContain('1000');
    expect(body).toContain('Custom'); // Enterprise configurable
    // four provider rows rendered
    expect(h.byId('modal-body').querySelectorAll('.prov-row').length).toBe(4);
  });

  it('shows Demo/Off badges when providers are stubbed', async () => {
    const h = loadClient({
      fetch: sessionWith({ provider_status: { stt: 'stub', llm: 'stub', search: 'off', auth: 'stub' } }),
    });
    await h.tick();
    h.nav.providers.dispatch('click', { preventDefault() {} });
    const badges = h.byId('modal-body').querySelectorAll('.prov-badge').map((b: any) => b.textContent);
    expect(badges).toContain('Demo');
    expect(badges).toContain('Off');
  });

  it('clicking Settings opens an account popup with identity + tier + usage', async () => {
    const h = loadClient({
      fetch: sessionWith({
        authenticated: true,
        account: { id: 'acc-1', tier: 'pro', display_name: 'Ada Lovelace' },
        identity: { provider: 'google', email: 'ada@example.com', display_name: 'Ada Lovelace' },
        quota: { tier: 'pro', used: 12, limit: 200, retention_window_days: 360, exceeded: false },
      }),
    });
    await h.tick();
    h.nav.settings.dispatch('click', { preventDefault() {} });

    expect(h.byId('modal-overlay').hidden).toBe(false);
    expect(h.byId('modal-title').textContent).toBe('Account');
    const body = h.byId('modal-body').textContent;
    expect(body).toContain('Ada Lovelace');
    expect(body).toContain('ada@example.com');
    expect(body).toContain('Pro');
    expect(body).toContain('12 of 200');
    // a sign-out action is present
    expect(body).toContain('Sign out');
  });

  it('Settings popup offers sign-in when anonymous', async () => {
    const h = loadClient({ fetch: sessionWith() }); // authenticated:false
    await h.tick();
    h.nav.settings.dispatch('click', { preventDefault() {} });
    const body = h.byId('modal-body');
    expect(body.textContent).toContain('anonymously');
    const btns = body.querySelectorAll('button');
    expect(btns.length).toBeGreaterThanOrEqual(2); // google + microsoft
    btns[0]!.dispatch('click', {});
    expect(h.location.href).toBe('/auth/google/login');
  });

  it('closes via the close button, the backdrop, and Escape', async () => {
    const h = loadClient({ fetch: sessionWith() });
    await h.tick();
    const overlay = h.byId('modal-overlay');

    // close button
    h.nav.providers.dispatch('click', { preventDefault() {} });
    expect(overlay.hidden).toBe(false);
    h.byId('modal-close').dispatch('click', {});
    expect(overlay.hidden).toBe(true);

    // backdrop (click on the overlay itself: target === overlay)
    h.nav.providers.dispatch('click', { preventDefault() {} });
    overlay.dispatch('click', { target: overlay });
    expect(overlay.hidden).toBe(true);

    // a click INSIDE the modal (target !== overlay) does NOT close it
    h.nav.providers.dispatch('click', { preventDefault() {} });
    overlay.dispatch('click', { target: h.byId('modal-body') });
    expect(overlay.hidden).toBe(false);

    // Escape closes it
    h.fireDoc('keydown', { key: 'Escape' });
    expect(overlay.hidden).toBe(true);
  });
});

describe('Focus popups — Workspace/Insights tabs show one section exclusively', () => {
  it('Transcript tab relocates the live transcript card into the modal and restores it on close', () => {
    const h = loadClient();
    expect(h.byId('card-transcript').parentNode).toBe(h.grid);
    expect(h.byId('modal-overlay').hidden).toBe(true);

    h.nav.transcript.dispatch('click', { preventDefault() {} });

    // Popup is open, titled "Transcript", and the LIVE card itself moved in (so it
    // keeps updating) — it is not a static clone.
    expect(h.byId('modal-overlay').hidden).toBe(false);
    expect(h.byId('modal-title').textContent).toBe('Transcript');
    expect(h.byId('card-transcript').parentNode).toBe(h.byId('modal-body'));
    expect(h.byId('modal-overlay').classList.contains('modal-focus')).toBe(true);

    // Close → the card goes back to its exact spot in the grid, ahead of explanation.
    h.byId('modal-close').dispatch('click', {});
    expect(h.byId('modal-overlay').hidden).toBe(true);
    expect(h.byId('card-transcript').parentNode).toBe(h.grid);
    expect(h.grid.children[0]).toBe(h.byId('card-transcript'));
    expect(h.grid.children[1]).toBe(h.byId('card-explanation'));
  });

  it('the relocated transcript keeps rendering live envelopes while popped', () => {
    const h = loadClient();
    const ws = h.sockets[0]!;
    ws.readyState = 1;
    ws.onmessage!({ data: JSON.stringify({ type: 'status', mode: 'live', providers: {} }) });

    h.nav.transcript.dispatch('click', { preventDefault() {} });
    // A new final line arrives AFTER the card was moved into the modal.
    ws.onmessage!({
      data: JSON.stringify({ type: 'envelope', env: { segment_id: 's9', rev: 1, is_final: true, text: 'Live while focused', speaker: { display_name: 'Eve' } } }),
    });
    expect(h.byId('transcript').textContent).toContain('Live while focused');
    expect(h.byId('card-transcript').parentNode).toBe(h.byId('modal-body'));
  });

  it('Activity tab relocates the stat row into the modal', () => {
    const h = loadClient();
    const home = h.byId('card-stats').parentNode;
    h.nav.activity.dispatch('click', { preventDefault() {} });
    expect(h.byId('modal-title').textContent).toBe('Activity');
    expect(h.byId('card-stats').parentNode).toBe(h.byId('modal-body'));
    h.byId('modal-close').dispatch('click', {});
    expect(h.byId('card-stats').parentNode).toBe(home);
  });

  it('switching directly between two focus tabs never strands a relocated card', () => {
    const h = loadClient();
    h.nav.transcript.dispatch('click', { preventDefault() {} });
    expect(h.byId('card-transcript').parentNode).toBe(h.byId('modal-body'));

    // Open Explanation while Transcript is still open: transcript must return to the
    // grid, explanation takes the modal.
    h.nav.explanation.dispatch('click', { preventDefault() {} });
    expect(h.byId('card-transcript').parentNode).toBe(h.grid);
    expect(h.byId('card-explanation').parentNode).toBe(h.byId('modal-body'));
    expect(h.byId('modal-title').textContent).toBe('Explanation');
  });

  it('Sources tab lists the de-duplicated cited web pages (and refreshes live)', () => {
    const h = loadClient();

    // Empty state before anything is explained.
    h.nav.sources.dispatch('click', { preventDefault() {} });
    expect(h.byId('modal-title').textContent).toBe('Sources');
    expect(h.byId('modal-body').textContent).toContain('No web sources cited yet');

    // Drive an explained question carrying a source; the OPEN Sources popup updates.
    liveWithExplained(h);
    const body = h.byId('modal-body');
    expect(body.textContent).toContain('Investopedia');
    const links = body.querySelectorAll('a');
    expect(links.some((a: any) => a.href === 'https://x/arr')).toBe(true);
  });

  it('"Live Session" closes any focus popup and shows the full dashboard again', () => {
    const h = loadClient();
    h.nav.transcript.dispatch('click', { preventDefault() {} });
    expect(h.byId('modal-overlay').hidden).toBe(false);

    h.nav.live.dispatch('click', { preventDefault() {} });
    expect(h.byId('modal-overlay').hidden).toBe(true);
    expect(h.byId('card-transcript').parentNode).toBe(h.grid);
    // The Live Session tab is the active one once we're back to the full view.
    expect(h.nav.live.classList.contains('active')).toBe(true);
    expect(h.nav.transcript.classList.contains('active')).toBe(false);
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

describe('F2 — bring-your-own sources', () => {
  it('adds a user source, rides the next ask frame, and removing it drops it', () => {
    const h = loadClient();
    const ws = liveWithExplained(h);

    // Open the Sources popup and add a user source via the add form.
    h.nav.sources.dispatch('click', { preventDefault() {} });
    const body = h.byId('modal-body');
    const textarea = body.querySelector('.usrc-textarea');
    expect(textarea).toBeTruthy();
    textarea.value = 'Our product launches in Q4.';
    body.querySelector('.usrc-add').dispatch('click', {});

    // It shows in the (re-rendered) popup's "Your sources" section.
    expect(h.byId('modal-body').textContent).toContain('Our product launches in Q4.');

    // A follow-up ask now carries the user source.
    h.byId('followup-input').value = 'when do we launch?';
    h.byId('followup').dispatch('submit', { preventDefault() {} });
    let asks = ws.sent.map((s) => JSON.parse(s)).filter((m: any) => m.type === 'ask');
    const ask1 = asks[asks.length - 1];
    expect(ask1.user_sources).toHaveLength(1);
    expect(ask1.user_sources[0]).toMatchObject({ text: 'Our product launches in Q4.' });
    expect(typeof ask1.user_sources[0].id).toBe('string');

    // Remove it via the ✕; a subsequent ask carries no user sources.
    h.byId('modal-body').querySelector('.usrc-remove').dispatch('click', {});
    h.byId('followup-input').value = 'and pricing?';
    h.byId('followup').dispatch('submit', { preventDefault() {} });
    asks = ws.sent.map((s) => JSON.parse(s)).filter((m: any) => m.type === 'ask');
    const ask2 = asks[asks.length - 1];
    expect(ask2.user_sources).toHaveLength(0);
  });

  it('ships an empty user_sources list on the explain frame when none are added', () => {
    const h = loadClient();
    const ws = liveWithExplained(h);
    const explain = ws.sent.map((s) => JSON.parse(s)).find((m: any) => m.type === 'explain');
    expect(explain.user_sources).toEqual([]);
  });
});

describe('F1 — Saved-session history popup', () => {
  /** A signed-in backend mock with a stateful saved-session store. */
  function makeBackend() {
    let sessions = [
      { id: 's-2', title: 'Pricing sync', artifact_count: 3, consent_class: 'standard', created_at_us: 2_000_000 },
      { id: 's-1', title: 'Roadmap call', artifact_count: 2, consent_class: 'sensitive', created_at_us: 1_000_000 },
    ];
    const quota = () => ({ tier: 'free', used: sessions.length, limit: 5, retention_window_days: 7, exceeded: false });
    const fetch = (url: string, init?: any) => {
      const method = (init && init.method) || 'GET';
      if (url === '/api/sessions' && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ sessions: sessions.slice(), quota: quota() }) };
      }
      if (url.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.slice('/api/sessions/'.length));
        if (method === 'DELETE') {
          sessions = sessions.filter((s) => s.id !== id);
          return { ok: true, status: 200, json: async () => ({ ok: true, quota: quota() }) };
        }
        const s = sessions.find((x) => x.id === id) || sessions[0];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            session: s,
            artifacts: [
              { kind: 'transcript_segment', payload: { who: 'Alice', text: 'Hello from the saved session.' } },
              { kind: 'transcript_segment', payload: { who: 'Bob', text: 'Second saved line.' } },
            ],
          }),
        };
      }
      if (url.startsWith('/api/session')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            account: { id: 'acc-1', tier: 'free', display_name: 'Ada' },
            identity: { provider: 'google', email: 'ada@x.com', display_name: 'Ada' },
            quota: quota(),
            providers: ['google'],
            authMode: 'real',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    return { fetch };
  }

  it('lists saved sessions newest-first with title / when / size / consent', async () => {
    const h = loadClient({ fetch: makeBackend().fetch });
    await h.tick();
    h.nav.history.dispatch('click', { preventDefault() {} });
    await h.tick();

    expect(h.byId('modal-title').textContent).toBe('Saved sessions');
    const body = h.byId('modal-body');
    expect(body.textContent).toContain('Pricing sync');
    expect(body.textContent).toContain('Roadmap call');
    expect(body.textContent).toContain('Sensitive'); // the sensitive row carries a chip
    // Newest-first: Pricing sync (created 2.0s) before Roadmap call (1.0s).
    const titles = body.querySelectorAll('.hist-title').map((n: any) => n.textContent);
    expect(titles[0]).toBe('Pricing sync');
    expect(titles[1]).toBe('Roadmap call');
  });

  it('opens a saved session into a read-only transcript, then Back returns to the list', async () => {
    const h = loadClient({ fetch: makeBackend().fetch });
    await h.tick();
    h.nav.history.dispatch('click', { preventDefault() {} });
    await h.tick();

    h.byId('modal-body').querySelector('.hist-open').dispatch('click', {});
    await h.tick();
    expect(h.byId('modal-body').textContent).toContain('Hello from the saved session.');
    expect(h.byId('modal-body').textContent).toContain('Second saved line.');

    h.byId('modal-body').querySelector('.hist-back').dispatch('click', {});
    await h.tick();
    expect(h.byId('modal-body').textContent).toContain('Pricing sync');
  });

  it('surfaces an error (not a silent no-op) when opening a session fails, with a Back to the list', async () => {
    // Mirror the real failure that made the Open button look dead: a stale server
    // with no GET /api/sessions/:id route answers 404, so the by-id fetch is not ok.
    const base = makeBackend().fetch;
    const fetch = (url: string, init?: any) => {
      const method = (init && init.method) || 'GET';
      if (url.startsWith('/api/sessions/') && method === 'GET') {
        return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
      }
      return base(url, init);
    };
    const h = loadClient({ fetch });
    await h.tick();
    h.nav.history.dispatch('click', { preventDefault() {} });
    await h.tick();

    h.byId('modal-body').querySelector('.hist-open').dispatch('click', {});
    await h.tick();
    // Something happened: an explicit error message, not the unchanged list.
    expect(h.byId('modal-body').textContent).toContain('Could not open this saved session');

    // Back returns to the list so the user can retry / pick another.
    h.byId('modal-body').querySelector('.hist-back').dispatch('click', {});
    await h.tick();
    expect(h.byId('modal-body').textContent).toContain('Pricing sync');
  });

  it('deletes a saved session after an inline confirm and refreshes the quota meter', async () => {
    const h = loadClient({ fetch: makeBackend().fetch });
    await h.tick();
    expect(h.byId('quota-text').textContent).toBe('2 of 5'); // boot meter

    h.nav.history.dispatch('click', { preventDefault() {} });
    await h.tick();

    // First click → inline "Delete?" confirm affordance (no window.confirm).
    h.byId('modal-body').querySelector('.hist-del').dispatch('click', {});
    const yes = h.byId('modal-body').querySelector('.hist-del-yes');
    expect(yes).toBeTruthy();
    yes.dispatch('click', {});
    await h.tick();

    const del = h.fetchCalls.find(
      (c) => c.url.startsWith('/api/sessions/') && (c.init as any) && (c.init as any).method === 'DELETE',
    );
    expect(del).toBeTruthy();
    // Freed a slot → the account quota meter updated, and the row is gone.
    expect(h.byId('quota-text').textContent).toBe('1 of 5');
    const titles = h.byId('modal-body').querySelectorAll('.hist-title').map((n: any) => n.textContent);
    expect(titles).not.toContain('Pricing sync');
  });

  it('shows a sign-in prompt to an anonymous user and never fetches the list', async () => {
    const h = loadClient(); // default fetch → anonymous
    await h.tick();
    h.nav.history.dispatch('click', { preventDefault() {} });
    await h.tick();
    expect(h.byId('modal-body').textContent).toContain('Sign in to save sessions');
    expect(h.fetchCalls.some((c) => c.url === '/api/sessions')).toBe(false);
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
