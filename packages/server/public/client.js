/*
 * Aizen browser client. Three jobs:
 *   1) Capture the microphone, downsample to 16 kHz PCM16 mono, and stream the
 *      bytes to the server over a binary WebSocket (the server forwards them to
 *      Deepgram).
 *   2) Receive transcript envelopes pushed back by the server and fold them into
 *      a live transcript (partials update in place, then finalize).
 *   3) On a click of a final sentence, ask the server to EXPLAIN it — the meaning
 *      of the phrase, a breakdown of its key words, and (for questions) a short
 *      web-grounded answer with sources — and render it in the side panel.
 *
 * No build step — plain ES2017 the browser runs directly.
 */
(() => {
  'use strict';

  const els = {
    status: document.getElementById('status'),
    mic: document.getElementById('mic'),
    sys: document.getElementById('sys'),
    both: document.getElementById('both'),
    transcript: document.getElementById('transcript'),
    explanation: document.getElementById('explanation'),
    hint: document.getElementById('hint'),
    // Dashboard chrome (all optional — guarded so the core flow never breaks if
    // the markup changes). These drive the stat cards, the transcript filter,
    // the connection chip, and the mobile sidebar drawer.
    statLines: document.getElementById('stat-lines'),
    statQuestions: document.getElementById('stat-questions'),
    statSources: document.getElementById('stat-sources'),
    statWords: document.getElementById('stat-words'),
    search: document.getElementById('transcript-search'),
    connChip: document.getElementById('conn-chip'),
    sidebar: document.getElementById('sidebar'),
    navToggle: document.getElementById('nav-toggle'),
    navBackdrop: document.getElementById('nav-backdrop'),
    // F1 follow-up: type a question after a sentence is explained.
    followupForm: document.getElementById('followup'),
    followupInput: document.getElementById('followup-input'),
    followupSend: document.getElementById('followup-send'),
    followupThread: document.getElementById('followup-thread'),
    // F2 pop-out: float the live view in its own window.
    popout: document.getElementById('popout'),
    cardTranscript: document.getElementById('card-transcript'),
    cardExplanation: document.getElementById('card-explanation'),
    // Light/dark theme toggle (light is the default).
    themeToggle: document.getElementById('theme-toggle'),
    // Account widget (sign in/out, identity + tier, quota usage).
    acctSignin: document.getElementById('acct-signin'),
    signinBtn: document.getElementById('signin-btn'),
    acctMenu: document.getElementById('acct-menu'),
    acctUser: document.getElementById('acct-user'),
    acctChip: document.getElementById('acct-chip'),
    acctAvatar: document.getElementById('acct-avatar'),
    acctName: document.getElementById('acct-name'),
    acctTier: document.getElementById('acct-tier'),
    acctPanel: document.getElementById('acct-panel'),
    acctFullname: document.getElementById('acct-fullname'),
    acctEmail: document.getElementById('acct-email'),
    quota: document.getElementById('quota'),
    quotaText: document.getElementById('quota-text'),
    quotaFill: document.getElementById('quota-fill'),
    quotaOver: document.getElementById('quota-over'),
    saveSessionBtn: document.getElementById('save-session-btn'),
    acctMsg: document.getElementById('acct-msg'),
    signoutBtn: document.getElementById('signout-btn'),
    // Popup/modal (Providers + Settings sidebar tabs).
    modalOverlay: document.getElementById('modal-overlay'),
    modalTitle: document.getElementById('modal-title'),
    modalBody: document.getElementById('modal-body'),
    modalClose: document.getElementById('modal-close'),
    // Live intelligence panels (concept cards / insights / recap / knowledge graph).
    concepts: document.getElementById('concepts'),
    conceptsCount: document.getElementById('concepts-count'),
    insights: document.getElementById('insights'),
    insightsCount: document.getElementById('insights-count'),
    summary: document.getElementById('summary'),
    summaryStamp: document.getElementById('summary-stamp'),
    summaryRefresh: document.getElementById('summary-refresh'),
    graph: document.getElementById('graph'),
    graphExpand: document.getElementById('graph-expand'),
    exportBtn: document.getElementById('export-btn'),
  };

  // Free-text transcript filter (set by the top-bar search box). Empty = show all.
  let filterText = '';

  // ---- live model ----------------------------------------------------------
  const model = {
    transcript: new Map(), // segment_id -> latest line {rev, is_final, who, text}
    explanations: new Map(), // segment_id -> {state:'loading'|'done', ex?}
    followups: [], // ordered Q→A thread: {ask_id, segment_id, question, state, answer?, error?}
    // Live intelligence (F02 envelopes from the always-on live-intel worker):
    cards: new Map(), // concept_card.id -> latest ConceptCard revision
    insights: new Map(), // insight_item.id -> latest InsightItem revision
    summary: null, // latest SessionSummary {text, bullets, updated_at_us}
    graph: { nodes: new Map(), edges: new Map() }, // accumulated from kg_delta envelopes
    // S0: the canonical source library lives in window.AizenSources. These two are
    // CLIENT-side view state only:
    userSources: [], // legacy paste-only fallback used iff sources.js failed to load
    fileEntries: [], // F3 per-file UI rows: {id, name, size, status, error?, docId?}
    obsidian: { status: 'idle', vaultName: '', notes: 0, chunks: 0, error: '', busy: false }, // F4
  };
  let userSourceSeq = 0; // monotonic counter → unique id per added user source (legacy)
  let fileEntrySeq = 0; // monotonic counter → unique id per added file row
  let mode = 'demo';
  let currentSessionId = null; // the live session id (from the server status frame)
  let wsProviderStatus = null; // {stt,llm,search,auth} from the WS status frame
  let selected = null; // segment_id whose explanation is shown in the side panel
  const requested = new Set(); // segment_ids we've already asked the server to explain
  let askSeq = 0; // monotonic counter → unique ask_id per follow-up (match reply→thread)
  const FOLLOWUP_UI_TIMEOUT_MS = 45000; // client-side backstop so a follow-up never spins forever

  // Streaming (#1): live DOM nodes we append answer deltas into, so a streamed answer
  // updates IN PLACE instead of re-rendering the whole panel/thread once per token.
  let streamAnswerNode = null; // the explain panel's answer <p> currently streaming
  let streamAnswerSeg = null; // its segment_id
  let streamFuNode = null; // the follow-up thread's answer <p> currently streaming
  let streamFuAsk = null; // its ask_id

  function isF02(env) {
    return env && Object.prototype.hasOwnProperty.call(env, 'message_type');
  }

  // Client-side question heuristic — mirrors the server's `looksLikeQuestion`, so
  // we only auto-spend an explain call on sentences that actually ask something.
  function looksLikeQuestion(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return false;
    if (t.endsWith('?')) return true;
    return /^(who|what|when|where|why|how|which|whose|whom|is|are|am|was|were|do|does|did|can|could|should|would|will|shall|may|might|have|has|had)\b/.test(
      t,
    );
  }

  function foldEnvelope(env) {
    if (!env) return;
    // F02 = live intelligence (concept_card / insight_item / kg_delta / session_summary).
    if (isF02(env)) {
      foldF02(env);
      return;
    }
    // F01: a TranscriptSegment has these fields (an AudioFrame does not).
    if ('segment_id' in env && 'text' in env && 'is_final' in env) {
      model.transcript.set(env.segment_id, {
        rev: env.rev,
        is_final: env.is_final,
        who: env.speaker && env.speaker.display_name ? env.speaker.display_name : 'Speaker',
        text: env.text,
      });
      // Auto-answer: as soon as a sentence FINALIZES and looks like a question,
      // request its explanation automatically (no click). One request per segment.
      if (env.is_final && looksLikeQuestion(env.text)) {
        requestExplain(env.segment_id, env.text);
      }
      renderTranscript();
    }
  }

  // Route a live-intelligence (F02) envelope into the model, then schedule the
  // affected panel to re-render. These ride the SAME socket as transcript frames —
  // the server relays every bus envelope, and the always-on live-intel worker is
  // their producer. Folded by stable id, keeping the latest revision, so a concept or
  // insight that is re-surfaced updates IN PLACE instead of duplicating.
  function foldF02(env) {
    switch (env.message_type) {
      case 'concept_card': {
        const c = env.card;
        if (!c || !c.id) return;
        if (c.state === 'retracted') {
          model.cards.delete(c.id);
        } else {
          const prev = model.cards.get(c.id);
          if (!prev || (c.revision || 0) >= (prev.revision || 0)) model.cards.set(c.id, c);
        }
        scheduleRender('concepts');
        break;
      }
      case 'insight_item': {
        const i = env.insight;
        if (!i || !i.id) return;
        const prev = model.insights.get(i.id);
        if (!prev || (i.revision || 0) >= (prev.revision || 0)) model.insights.set(i.id, i);
        scheduleRender('insights');
        break;
      }
      case 'kg_delta': {
        applyKgDelta(env.delta);
        scheduleRender('graph');
        break;
      }
      case 'session_summary': {
        if (env.summary) model.summary = env.summary;
        if (recapPending) {
          // The recap we asked for just landed — re-enable the "Catch me up" button.
          if (recapTimer) clearTimeout(recapTimer);
          setRecapBusy(false);
        }
        scheduleRender('summary');
        break;
      }
    }
  }

  // Apply one kg_delta to the accumulated graph model (upsert by id, remove by id).
  function applyKgDelta(delta) {
    if (!delta) return;
    (delta.upsert_nodes || []).forEach((n) => {
      if (n && n.id) model.graph.nodes.set(n.id, n);
    });
    (delta.upsert_edges || []).forEach((e) => {
      if (e && e.id) model.graph.edges.set(e.id, e);
    });
    (delta.remove_node_ids || []).forEach((id) => model.graph.nodes.delete(id));
    (delta.remove_edge_ids || []).forEach((id) => model.graph.edges.delete(id));
  }

  // rAF-coalesced panel renders: a burst of F02 envelopes (one extraction emits a
  // kg_delta plus several concept_cards/insights at once) triggers at most one render
  // per panel per frame. Falls back to a timer where rAF is unavailable (test DOM).
  let renderScheduled = false;
  const dirtyPanels = new Set();
  function scheduleRender(which) {
    dirtyPanels.add(which);
    if (renderScheduled) return;
    renderScheduled = true;
    const flush = () => {
      renderScheduled = false;
      const panels = new Set(dirtyPanels);
      dirtyPanels.clear();
      if (panels.has('concepts')) renderConcepts();
      if (panels.has('insights')) renderInsights();
      if (panels.has('summary')) renderSummary();
      if (panels.has('graph')) renderGraph();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  // The recent FINAL transcript lines (oldest→newest), capped to bound frame size.
  // Shipped as conversation context with an explain/ask so the engine can read a
  // sentence that a long pause split across lines together with its neighbours — and
  // so that context survives a WS reconnect (a fresh server session's buffer starts
  // empty; the browser keeps the whole transcript).
  function recentTranscript() {
    const lines = [];
    for (const line of model.transcript.values()) {
      if (line.is_final && line.text) lines.push(line.text);
    }
    return lines.slice(-12);
  }

  // Ask the server to explain a sentence, at most once per segment. Used by both
  // the auto-answer path (final questions) and a manual click (any final line).
  function requestExplain(id, text) {
    if (requested.has(id)) return;
    requested.add(id);
    model.explanations.set(id, { state: 'loading' });
    if (ws.readyState === WebSocket.OPEN) {
      // The "current query" for retrieval (S0) is the sentence being explained;
      // `transcript` is the surrounding live conversation (split-by-pause context).
      ws.send(
        JSON.stringify({
          type: 'explain',
          segment_id: id,
          text,
          transcript: recentTranscript(),
          user_sources: userSourcesForSend(text),
          // Answering-preference toggles (Settings / Providers). Sent every frame so
          // the choice survives a WS reconnect with no server session state.
          fast: fastAnswersEnabled(),
          web_search: webSearchEnabled(),
        }),
      );
    }
  }

  // ---- on-demand recap ("Catch me up") -------------------------------------
  // Ask the server to regenerate the "what you've missed" recap now instead of
  // waiting for the cadence. The fresh recap arrives as a normal session_summary
  // envelope, which clears the busy state (below). A timeout is the backstop so the
  // button never sticks if no fresh recap comes (empty window / demo / capped LLM).
  let recapPending = false;
  let recapTimer = null;
  function setRecapBusy(busy) {
    recapPending = busy;
    const btn = els.summaryRefresh;
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('is-busy', busy);
    const txt = btn.querySelector('.btn-txt');
    if (txt) txt.textContent = busy ? 'Catching up…' : 'Catch up';
  }
  function requestRecap() {
    if (recapPending) return; // one in flight already
    if (!ws || ws.readyState !== WebSocket.OPEN) return; // not connected — no-op
    ws.send(JSON.stringify({ type: 'recap' }));
    setRecapBusy(true);
    if (recapTimer) clearTimeout(recapTimer);
    recapTimer = setTimeout(() => setRecapBusy(false), 12000);
  }

  // ---- S0 / F2–F4: BYO source library + top-k retrieval --------------------
  // The canonical library lives in window.AizenSources (sources.js, loaded first):
  // it owns pasted notes (F2), local files (F3), and Obsidian notes (F4), chunks
  // them, and selects only the chunks relevant to the CURRENT query per request
  // (S0). client.js is a thin producer/consumer over it. If sources.js somehow
  // failed to load, we fall back to a paste-only array so the app never breaks.
  function srcLib() {
    return typeof window !== 'undefined' && window.AizenSources ? window.AizenSources : null;
  }

  // The active set shipped WITH every explain/ask request — only the chunks the S0
  // retriever picks for `queryText` (the sentence being explained, or the typed
  // question). It rides each request (mirroring the follow-up context) so BYO
  // grounding survives a WS reconnect with no server-side session state. With no
  // library/query it returns the most-recent sources, so the pre-S0 behaviour (ship
  // the pasted notes) is byte-for-byte intact. Bounded again server-side.
  function userSourcesForSend(queryText) {
    const lib = srcLib();
    if (lib) {
      try {
        return lib.selectFor(queryText || '', { maxChunks: 8, maxCharsPerChunk: 600 });
      } catch {
        return [];
      }
    }
    // Legacy fallback (sources.js absent): ship pasted notes as before.
    return model.userSources.slice(0, 20).map((u) => {
      const o = { id: u.id, text: (u.text || '').slice(0, 4096), origin: 'paste' };
      if (u.title) o.title = u.title.slice(0, 200);
      if (u.url) o.url = u.url.slice(0, 2048);
      return o;
    });
  }

  // A pasted note → a doc with origin:'paste' in the library (or the legacy array).
  function addUserSource(src) {
    const text = src && src.text ? String(src.text).trim() : '';
    if (!text) return;
    const title = src.title ? String(src.title).trim() : '';
    const url = src.url ? String(src.url).trim() : '';
    const lib = srcLib();
    if (lib) {
      lib.addDoc({ origin: 'paste', text, title: title || undefined, url: url || undefined });
    } else {
      userSourceSeq += 1;
      const entry = { id: 'us_' + userSourceSeq, text };
      if (title) entry.title = title;
      if (url) entry.url = url;
      model.userSources.push(entry);
    }
    refreshFocusData(); // re-render an open Sources popup so the new row shows
  }

  function removeUserSource(id) {
    deleteStoredSource(id); // F3 Phase B — also drop the account-stored copy (frees quota)
    const lib = srcLib();
    if (lib) lib.removeDoc(id);
    else model.userSources = model.userSources.filter((u) => u.id !== id);
    refreshFocusData();
  }

  // The pasted-note docs to render in "Your sources" (origin:'paste' only; files and
  // Obsidian notes get their own sections below).
  function pasteSources() {
    const lib = srcLib();
    return lib ? lib.listDocs('paste') : model.userSources;
  }

  // ---- F3: local files as sources (Phase A — BYO, client-side extraction) --
  // A picked/dropped file → extracted text → an origin:'file' doc in the S0 library.
  // A big file doesn't blow the prompt budget because retrieval (S0) selects only
  // the relevant chunks per query. Files live ONLY in the browser this session (same
  // privacy posture as a pasted note, F3 §9); Phase B adds opt-in persistence.

  // Native-text extensions we read directly (F3 §3). Anything else that isn't a PDF
  // gets a clear per-file "unsupported" error and is skipped (never blocks others).
  const TEXT_EXTS = [
    'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'log',
    'yaml', 'yml', 'xml', 'html', 'htm', 'rtf', 'tex', 'rst', 'org',
    // common code files (read as text)
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c',
    'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'css',
    'scss', 'less', 'toml', 'ini', 'cfg', 'conf', 'env', 'gradle', 'r', 'jl', 'lua',
    'pl', 'vue', 'svelte', 'astro',
  ];
  const MAX_FILE_BYTES = 12 * 1024 * 1024; // refuse to read a file larger than this

  function fileExt(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function isPdf(file) {
    return fileExt(file.name) === 'pdf' || file.type === 'application/pdf';
  }

  // Extract a file's text by type. Resolves to the text, or rejects with a short
  // reason ('unsupported' | 'empty' | 'too-large' | a parser message).
  function extractFileText(file) {
    if (file.size != null && file.size > MAX_FILE_BYTES) {
      return Promise.reject(new Error('too-large'));
    }
    const ext = fileExt(file.name);
    const textual = TEXT_EXTS.indexOf(ext) !== -1 || (file.type && file.type.indexOf('text/') === 0);
    if (textual) {
      return file.text().then((t) => (t && t.trim() ? t : Promise.reject(new Error('empty'))));
    }
    if (isPdf(file)) return extractPdfText(file);
    return Promise.reject(new Error('unsupported'));
  }

  // PDF extraction via a VENDORED pdf.js (F3 §3 / §13 default: vendored, offline-safe,
  // no external CDN). Loaded lazily from /vendor/pdf.mjs only when a PDF is added; if
  // it isn't present, we surface a clear, skippable error rather than failing the lot.
  let pdfLibPromise = null;
  function loadPdfLib() {
    if (pdfLibPromise) return pdfLibPromise;
    pdfLibPromise = import('/vendor/pdf.mjs')
      .then((mod) => {
        const lib = mod && (mod.getDocument ? mod : mod.default);
        if (!lib || !lib.getDocument) throw new Error('pdf-lib-missing');
        if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
        return lib;
      })
      .catch(() => {
        pdfLibPromise = null; // allow a retry once the vendor file is dropped in
        throw new Error('pdf-unavailable');
      });
    return pdfLibPromise;
  }

  function extractPdfText(file) {
    return loadPdfLib()
      .then((lib) => file.arrayBuffer().then((buf) => lib.getDocument({ data: buf }).promise))
      .then((pdf) => {
        const pages = [];
        let chain = Promise.resolve();
        for (let i = 1; i <= pdf.numPages; i++) {
          chain = chain
            .then(() => pdf.getPage(i))
            .then((page) => page.getTextContent())
            .then((tc) => pages.push((tc.items || []).map((it) => it.str || '').join(' ')));
        }
        return chain.then(() => {
          const text = pages.join('\n\n').trim();
          if (!text) throw new Error('empty');
          return text;
        });
      });
  }

  function fileErrorMessage(err) {
    const m = err && err.message ? err.message : String(err);
    if (m === 'unsupported') return 'Unsupported file type — try .md, .txt, .csv, .json, code, or PDF.';
    if (m === 'too-large') return 'File is too large to add.';
    if (m === 'empty') return 'No readable text found.';
    if (m === 'pdf-unavailable') return 'PDF support needs the vendored pdf.js (see public/vendor/README).';
    return 'Could not read this file: ' + m;
  }

  // Add a list of File objects: one UI row each (parsing → ✓/error); each extracted
  // file becomes an origin:'file' doc. One failure never blocks the others (F3 §8).
  function addFiles(fileList) {
    const files = fileList ? Array.prototype.slice.call(fileList) : [];
    files.forEach((file) => {
      fileEntrySeq += 1;
      const entry = {
        id: 'fe_' + fileEntrySeq,
        name: file.name || 'file',
        size: file.size || 0,
        status: 'parsing',
      };
      model.fileEntries.push(entry);
      refreshFocusData();
      extractFileText(file)
        .then((text) => {
          const lib = srcLib();
          const doc = lib ? lib.addDoc({ origin: 'file', title: entry.name, text }) : null;
          entry.status = 'done';
          entry.docId = doc ? doc.id : null;
          entry.chunks = doc ? doc.chunks : 0;
          refreshFocusData();
        })
        .catch((err) => {
          entry.status = 'error';
          entry.error = fileErrorMessage(err);
          refreshFocusData();
        });
    });
  }

  function removeFileEntry(entry) {
    if (entry.docId) {
      deleteStoredSource(entry.docId); // F3 Phase B — drop the account-stored copy too
      const lib = srcLib();
      if (lib) lib.removeDoc(entry.docId);
    }
    model.fileEntries = model.fileEntries.filter((e) => e.id !== entry.id);
    refreshFocusData();
  }

  // ---- F4: connect your Obsidian vault (Phase 1 — picker / upload) ---------
  // A vault is a folder of markdown notes → a higher-volume producer for the S0
  // library (origin:'obsidian', title = vault-relative note path). Zero-install on
  // Chromium (showDirectoryPicker); a folder-upload fallback elsewhere. Read-only,
  // client-side, in-memory (F4 §7). Re-sync re-reads the folder; Disconnect clears.
  const MAX_OBSIDIAN_NOTES = 4000; // bound a pathological vault (S0 still caps the prompt)
  let obsidianProvider = null;
  let restoredObsidianHandle = null; // a persisted FS-Access handle awaiting a re-grant click

  function obsLib() {
    return typeof window !== 'undefined' && window.AizenObsidian ? window.AizenObsidian : null;
  }
  function setObsidian(patch) {
    Object.assign(model.obsidian, patch);
    refreshFocusData();
  }

  // Index a connected provider's notes into the library (origin:'obsidian'). Used by
  // first connect and by Re-sync (which clears the vault's docs first). Resolves to
  // the final {notes, chunks} counts from the library.
  function indexObsidian(provider) {
    return provider.listNotes().then((notes) => {
      const capped = notes.slice(0, MAX_OBSIDIAN_NOTES);
      const obs = obsLib();
      const lib = srcLib();
      let read = 0;
      let chain = Promise.resolve();
      capped.forEach((n) => {
        chain = chain
          .then(() => provider.readNote(n.path))
          .then((raw) => {
            const text = obs ? obs.parseMarkdown(raw) : String(raw || '');
            if (text && lib) lib.addDoc({ origin: 'obsidian', title: n.path, path: n.path, text });
            read += 1;
            if (read % 50 === 0) setObsidian({ notes: read }); // coarse progress for big vaults
          })
          .catch(() => {
            /* skip an unreadable note, keep indexing the rest */
          });
      });
      return chain.then(() => {
        const after = lib ? lib.stats('obsidian') : { docs: read, chunks: 0 };
        return { notes: after.docs, chunks: after.chunks };
      });
    });
  }

  function connectObsidian(opts) {
    const obs = obsLib();
    if (!obs) {
      setObsidian({ status: 'error', error: 'Obsidian support failed to load.' });
      return;
    }
    if (model.obsidian.busy) return;
    setObsidian({ status: 'connecting', error: '', busy: true });
    let provider;
    try {
      provider = obs.makeProvider(opts || {});
    } catch (e) {
      setObsidian({ status: 'error', busy: false, error: 'Could not start the Obsidian connect.' });
      return;
    }
    provider
      .connect()
      .then((info) => {
        obsidianProvider = provider;
        setObsidian({ vaultName: (info && info.vaultName) || 'vault' });
        // Persist the FS-Access handle for one-click reconnect next visit (F4 §3).
        if (provider.handle && obs.persist) {
          const h = provider.handle();
          if (h) obs.persist.saveHandle(h);
        }
        return indexObsidian(provider);
      })
      .then((res) => setObsidian({ status: 'connected', notes: res.notes, chunks: res.chunks, busy: false }))
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        setObsidian({
          status: model.obsidian.vaultName ? 'connected' : 'idle',
          busy: false,
          error:
            msg === 'permission-denied'
              ? 'Permission to read the vault was denied.'
              : msg === 'unsupported'
                ? 'This browser can’t pick a folder — use the upload fallback below.'
                : msg === 'no-directory-handle'
                  ? 'No folder was chosen.'
                  : 'Could not connect the vault.',
        });
      });
  }

  function resyncObsidian() {
    if (!obsidianProvider || model.obsidian.busy) return;
    const lib = srcLib();
    if (lib) lib.removeByOrigin('obsidian'); // re-read replaces the vault's docs
    setObsidian({ status: 'connecting', busy: true, notes: 0, chunks: 0, error: '' });
    indexObsidian(obsidianProvider)
      .then((res) => setObsidian({ status: 'connected', notes: res.notes, chunks: res.chunks, busy: false }))
      .catch(() => setObsidian({ status: 'connected', busy: false, error: 'Re-sync failed.' }));
  }

  function disconnectObsidian() {
    const lib = srcLib();
    if (lib) lib.removeByOrigin('obsidian');
    obsidianProvider = null;
    const obs = obsLib();
    if (obs && obs.persist) obs.persist.clearHandle();
    setObsidian({ status: 'idle', vaultName: '', notes: 0, chunks: 0, error: '', busy: false });
  }

  // Attempt a one-click reconnect from a persisted FS-Access handle on boot (F4 §3).
  // Silent on failure (no handle / permission not yet re-granted) — the user can
  // always click Connect. The actual permission re-grant happens on that click.
  function tryRestoreObsidian() {
    const obs = obsLib();
    if (!obs || !obs.persist || !obs.supportsDirectoryPicker || !obs.supportsDirectoryPicker()) return;
    obs.persist
      .loadHandle()
      .then((handle) => {
        if (handle) {
          restoredObsidianHandle = handle;
          model.obsidian.restorable = true; // surfaced as a "Reconnect" affordance
          refreshFocusData();
        }
      })
      .catch(() => {
        /* no persisted handle — nothing to restore */
      });
  }

  // Reconnect from the persisted handle (re-requests read permission on this click).
  function reconnectObsidian() {
    if (!restoredObsidianHandle) return;
    connectObsidian({ handle: restoredObsidianHandle });
  }

  // ---- F3 Phase B: persist sources to the signed-in account ----------------
  // Signed-in users can SAVE a source (a pasted note or a parsed file) so it reloads
  // into the S0 library on the next visit — account-scoped + byte-quota-gated
  // fail-closed (a 409 shows the same typed quota body the saved-sessions UI uses).
  // Only the EXTRACTED TEXT is stored (F3 §8). All guarded: anonymous users never see
  // any of this; with no `fetch` it stays inert.
  const savedDocIds = Object.create(null); // libDocId -> server stored-source id
  let sourceQuota = null; // {tier, used_bytes, limit_bytes, count, exceeded}
  let storedSourcesLoaded = false;

  function canPersistSources() {
    return !!account && typeof fetch === 'function';
  }

  // Load the account's stored sources back into the library on boot (F3 §8). The
  // list carries metadata only; each source's text is fetched by id and re-ingested.
  function bootStoredSources() {
    if (!canPersistSources() || storedSourcesLoaded) return;
    storedSourcesLoaded = true;
    fetch('/api/sources', { headers: { accept: 'application/json' } })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.sources) return;
        sourceQuota = data.quota || null;
        data.sources.slice(0, 100).forEach((meta) => loadStoredSource(meta));
        refreshFocusData();
      })
      .catch(() => {
        storedSourcesLoaded = false; // allow a retry on the next boot
      });
  }

  function loadStoredSource(meta) {
    fetch('/api/sources/' + encodeURIComponent(meta.id), { headers: { accept: 'application/json' } })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        const lib = srcLib();
        if (!data || !data.source || !lib) return;
        const s = data.source;
        const doc = lib.addDoc({ origin: s.origin, title: s.title, text: s.text });
        if (!doc) return;
        savedDocIds[doc.id] = s.id;
        // Surface a file/obsidian-origin source as a file row so it's visible/removable.
        if (s.origin === 'file') {
          fileEntrySeq += 1;
          model.fileEntries.push({
            id: 'fe_' + fileEntrySeq,
            name: s.title,
            size: s.bytes,
            status: 'done',
            docId: doc.id,
            chunks: doc.chunks,
          });
        }
        refreshFocusData();
      })
      .catch(() => {
        /* one source failing to reload never blocks the others */
      });
  }

  // Persist a library doc to the account; `onResult({ok, message?})` reports back so
  // the row can show an inline "Saved" / quota-exceeded message.
  function saveSourceToAccount(doc, onResult) {
    if (!doc || !canPersistSources()) return;
    fetch('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: doc.title || doc.origin + ' source', origin: doc.origin, text: doc.text }),
    })
      .then((r) => r.json().then((body) => ({ status: r.status, body })))
      .then(({ status, body }) => {
        if (status === 201 && body.saved) {
          savedDocIds[doc.id] = body.saved.id;
          sourceQuota = body.quota || sourceQuota;
          if (onResult) onResult({ ok: true });
          refreshFocusData();
        } else if (status === 409) {
          if (onResult)
            onResult({
              ok: false,
              message: (body && body.message ? body.message + ' ' : '') + (body && body.remedy ? body.remedy : ''),
            });
        } else if (onResult) {
          onResult({ ok: false, message: (body && (body.message || body.error)) || 'Could not save.' });
        }
      })
      .catch(() => {
        if (onResult) onResult({ ok: false, message: 'Could not save — please try again.' });
      });
  }

  // Delete the account-stored copy of a library doc (frees byte quota). Returns a
  // promise so a remove can await it. No-op when the doc was never saved.
  function deleteStoredSource(docId) {
    const storedId = savedDocIds[docId];
    if (!storedId || !canPersistSources()) return Promise.resolve();
    return fetch('/api/sources/' + encodeURIComponent(storedId), { method: 'DELETE' })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.quota) sourceQuota = data.quota;
        delete savedDocIds[docId];
      })
      .catch(() => {
        /* leave it; the user can retry */
      });
  }

  // Append a "Save to account" button (or a "Saved" badge) to a source row's main
  // column, when signed in. The button persists the doc and swaps to the badge.
  function appendSaveControls(main, doc) {
    if (!canPersistSources() || !doc) return;
    if (savedDocIds[doc.id]) {
      main.appendChild(mk('span', 'src-saved-badge', '✓ Saved'));
      return;
    }
    const row = mk('div', 'src-save-row');
    const btn = mk('button', 'btn btn-secondary src-save-btn', 'Save to account');
    btn.type = 'button';
    const msg = mk('span', 'src-save-msg');
    btn.addEventListener('click', () => {
      btn.disabled = true;
      msg.textContent = 'Saving…';
      msg.className = 'src-save-msg muted';
      saveSourceToAccount(doc, (res) => {
        if (res.ok) {
          // re-render replaces the button with the Saved badge
          refreshFocusData();
        } else {
          btn.disabled = false;
          msg.textContent = res.message || 'Could not save.';
          msg.className = 'src-save-msg usrc-file-error';
        }
      });
    });
    row.appendChild(btn);
    row.appendChild(msg);
    main.appendChild(row);
  }

  // The byte-quota line shown atop the files section when signed in ("X of N used").
  function storageLine() {
    if (!sourceQuota) return null;
    const used = formatBytes(sourceQuota.used_bytes || 0) || '0 B';
    const limit =
      sourceQuota.limit_bytes === null || sourceQuota.limit_bytes === undefined
        ? '∞'
        : formatBytes(sourceQuota.limit_bytes);
    const p = mk('p', 'src-storage', 'Saved to account: ' + used + ' of ' + limit);
    if (sourceQuota.exceeded) p.classList.add('usrc-file-error');
    return p;
  }

  // ---- rendering -----------------------------------------------------------
  // Auto-follow: the transcript (and the follow-up thread) are capped-height
  // scroll boxes that fill from the top down, so without help the newest content
  // lands below the fold the moment the box overflows. We keep the latest in view
  // by snapping to the bottom after a render — but ONLY when the reader was already
  // at (or near) the bottom. If they've scrolled up to re-read an earlier line,
  // leave their position alone so new arrivals don't yank them away. Guarded so the
  // headless DOM harness (no layout engine) and older runtimes are a silent no-op.
  const STICK_THRESHOLD_PX = 24; // slack so "near the bottom" follows reliably

  function nearBottom(el) {
    if (!el) return false;
    const sh = el.scrollHeight || 0;
    const st = el.scrollTop || 0;
    const ch = el.clientHeight || 0;
    return sh - st - ch <= STICK_THRESHOLD_PX;
  }

  function stickToBottom(el) {
    if (!el) return;
    const top = el.scrollHeight || 0;
    // Instant (not smooth): the transcript can re-render on every partial, and a
    // queued smooth animation per update reads as jitter — snap straight to the tail.
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'auto' });
    else el.scrollTop = top;
  }

  function renderTranscript() {
    // Capture whether the reader is following the live tail BEFORE rebuilding the
    // list — clearing innerHTML resets scrollTop, so this must be measured first.
    const follow = nearBottom(els.transcript);
    els.transcript.innerHTML = '';
    for (const [id, line] of model.transcript) {
      // Top-bar search filters the visible lines by substring (stats stay whole).
      if (filterText && !(line.text || '').toLowerCase().includes(filterText)) continue;
      const div = document.createElement('div');
      div.className = 'line ' + (line.is_final ? 'final' : 'partial');
      if (line.is_final) div.classList.add('clickable');
      if (id === selected) div.classList.add('selected');
      div.dataset.segmentId = id;
      div.innerHTML = `<span class="who"></span><span class="txt"></span>`;
      div.querySelector('.who').textContent = line.who + ':';
      div.querySelector('.txt').textContent = ' ' + line.text;
      // Inline answer (auto-answered questions render right under the sentence).
      const exState = model.explanations.get(id);
      if (line.is_final && exState) div.appendChild(buildInlineAnswer(exState));
      els.transcript.appendChild(div);
    }
    updateStats();
    if (follow) stickToBottom(els.transcript); // keep the newest line in view
  }

  // Recompute the dashboard stat cards from the live model. Derived purely from
  // existing state (transcript segments + completed explanations), so it never
  // affects capture/transcription/explain. Guarded for missing elements.
  function updateStats() {
    let words = 0;
    for (const line of model.transcript.values()) {
      if (line.text) words += line.text.trim().split(/\s+/).filter(Boolean).length;
    }
    let questions = 0;
    let sources = 0;
    for (const st of model.explanations.values()) {
      if (st.state === 'done' && st.ex) {
        if (st.ex.is_question && st.ex.answer) questions++;
        sources += st.ex.sources ? st.ex.sources.length : 0;
      }
    }
    setStat(els.statLines, model.transcript.size);
    setStat(els.statQuestions, questions);
    setStat(els.statSources, sources);
    setStat(els.statWords, words);
  }

  function setStat(el, value) {
    if (el) el.textContent = String(value);
  }

  // ---- live intelligence panels (concepts / insights / recap / graph) -------
  // All four are driven by the F02 envelopes folded above; each renders from the
  // model and is invoked (rAF-coalesced) by scheduleRender. A small `mk()` builder
  // (defined later, hoisted) keeps these terse and XSS-safe (textContent, never HTML).

  const CARD_KIND_LABEL = {
    acronym: 'acronym',
    jargon_term: 'jargon',
    concept: 'concept',
    topic: 'topic',
    metric: 'metric',
    event: 'event',
    reference: 'reference',
    entity_person: 'person',
    entity_org: 'org',
    entity_product: 'product',
    entity_location: 'place',
    entity_financial_instrument: 'instrument',
    entity_legal_ref: 'legal',
    entity_medical: 'medical',
  };

  function emptyState(text) {
    return mk('p', 'panel-empty', text);
  }

  function renderConcepts() {
    if (!els.concepts) return;
    // Most salient first; ties keep insertion (surfacing) order.
    const cards = [...model.cards.values()].sort((a, b) => (b.salience || 0) - (a.salience || 0));
    if (els.conceptsCount) els.conceptsCount.textContent = String(cards.length);
    els.concepts.innerHTML = '';
    if (!cards.length) {
      els.concepts.appendChild(emptyState('Concepts will appear here as the conversation unfolds.'));
      return;
    }
    cards.forEach((c) => els.concepts.appendChild(buildConceptCard(c)));
  }

  function buildConceptCard(c) {
    const seg = c.first_mention && c.first_mention.segment_id;
    const canDeepDive = !!(seg && model.transcript.has(seg));
    const el = mk(canDeepDive ? 'button' : 'div', 'concept-card');
    if (canDeepDive) {
      el.type = 'button';
      el.classList.add('clickable');
      el.title = 'Explain where this came up';
      el.addEventListener('click', () => selectAndExplain(seg));
    }
    const head = mk('div', 'cc-head');
    head.appendChild(mk('span', 'cc-name', c.canonical_name || c.surface_form));
    head.appendChild(mk('span', 'cc-kind cc-kind-' + (c.kind || 'concept'), CARD_KIND_LABEL[c.kind] || 'concept'));
    el.appendChild(head);
    if (c.definition_short) el.appendChild(mk('p', 'cc-def', c.definition_short));
    if ((c.mention_count || 0) > 1) el.appendChild(mk('span', 'cc-mentions', c.mention_count + ' mentions'));
    return el;
  }

  const INSIGHT_GROUPS = [
    { type: 'action_item', label: 'Action items' },
    { type: 'decision', label: 'Decisions' },
    { type: 'open_question', label: 'Open questions' },
    { type: 'risk', label: 'Risks' },
    { type: 'commitment', label: 'Commitments' },
  ];

  function renderInsights() {
    if (!els.insights) return;
    const all = [...model.insights.values()].filter((i) => i.status !== 'dismissed');
    if (els.insightsCount) els.insightsCount.textContent = String(all.length);
    els.insights.innerHTML = '';
    if (!all.length) {
      els.insights.appendChild(emptyState('Action items, decisions, and open questions will collect here.'));
      return;
    }
    INSIGHT_GROUPS.forEach((g) => {
      const items = all.filter((i) => i.insight_type === g.type);
      if (!items.length) return;
      const group = mk('div', 'insight-group insight-group-' + g.type);
      const h = mk('div', 'ig-head');
      h.appendChild(mk('span', 'ig-label', g.label));
      h.appendChild(mk('span', 'ig-count', String(items.length)));
      group.appendChild(h);
      items.forEach((i) => group.appendChild(buildInsightItem(i)));
      els.insights.appendChild(group);
    });
  }

  function buildInsightItem(i) {
    const el = mk('div', 'insight-item insight-' + i.insight_type);
    if (i.status === 'resolved') el.classList.add('resolved');
    el.appendChild(mk('span', 'ii-text', i.text));
    const meta = mk('div', 'ii-meta');
    if (i.owner_speaker_id) meta.appendChild(mk('span', 'ii-owner', i.owner_speaker_id));
    const seg = (i.evidence_segment_ids || [])[0];
    if (seg && model.transcript.has(seg)) {
      const jump = mk('button', 'ii-jump', 'evidence');
      jump.type = 'button';
      jump.addEventListener('click', () => selectAndExplain(seg));
      meta.appendChild(jump);
    }
    if (meta.childNodes.length) el.appendChild(meta);
    return el;
  }

  function renderSummary() {
    if (!els.summary) return;
    const s = model.summary;
    els.summary.innerHTML = '';
    if (!s || !s.text) {
      els.summary.appendChild(emptyState('A running recap of the conversation will appear here.'));
      if (els.summaryStamp) els.summaryStamp.textContent = 'live';
      return;
    }
    els.summary.appendChild(mk('p', 'summary-text', s.text));
    if (s.bullets && s.bullets.length) {
      const ul = mk('ul', 'summary-bullets');
      s.bullets.forEach((b) => ul.appendChild(mk('li', null, b)));
      els.summary.appendChild(ul);
    }
    if (els.summaryStamp) els.summaryStamp.textContent = 'updated ' + timeAgo(s.updated_at_us);
  }

  function timeAgo(us) {
    if (!us) return 'just now';
    const sec = Math.max(0, Math.round((Date.now() - us / 1000) / 1000));
    if (sec < 5) return 'just now';
    if (sec < 60) return sec + 's ago';
    return Math.round(sec / 60) + 'm ago';
  }

  // Knowledge graph (Phase 3): delegates to window.AizenGraph (graph.js) when present
  // and there are nodes; otherwise shows an empty state. Clicking a node opens a
  // popover anchored over it listing the transcript messages that concept refers to;
  // clicking a message deep-dives into it (the same web-grounded explain flow).
  function renderGraph() {
    if (!els.graph) return;
    const nodes = [...model.graph.nodes.values()];
    const edges = [...model.graph.edges.values()];
    if (typeof window !== 'undefined' && window.AizenGraph && nodes.length) {
      window.AizenGraph.render(els.graph, nodes, edges, (node, ui) => showNodeMessages(node, ui));
      return;
    }
    els.graph.innerHTML = '';
  }

  // The transcript messages a knowledge-graph node refers to, oldest→newest, deduped,
  // and limited to lines we actually have text for. A node's concept surfaces in three
  // places the client already accumulates: the node's own `first_seen_segment_id`, the
  // ConceptCard it links to (`first_mention` + every `mention_segment_ids` + citation
  // segments), and the evidence on any edge incident to the node.
  function nodeMessageSegments(node) {
    const ids = [];
    const seen = new Set();
    const add = (s) => {
      if (s && !seen.has(s)) {
        seen.add(s);
        ids.push(s);
      }
    };
    if (node.first_seen_segment_id) add(node.first_seen_segment_id);
    const card = node.concept_card_id ? model.cards.get(node.concept_card_id) : null;
    if (card) {
      if (card.first_mention && card.first_mention.segment_id) add(card.first_mention.segment_id);
      (card.mention_segment_ids || []).forEach(add);
      (card.sources || []).forEach((s) => (s.transcript_segment_ids || []).forEach(add));
    }
    for (const e of model.graph.edges.values()) {
      if (e && (e.src === node.id || e.dst === node.id)) (e.evidence_segment_ids || []).forEach(add);
    }
    return ids.filter((s) => model.transcript.has(s));
  }

  // Fill the graph popover (`ui.host`, an empty div graph.js keeps pinned over the
  // clicked node) with the node's label, type, and the messages it refers to. Each
  // message row deep-dives via the shared explain flow (and closes the popover first).
  function showNodeMessages(node, ui) {
    if (!node || !ui || !ui.host) return;
    const host = ui.host;
    const close = typeof ui.close === 'function' ? ui.close : () => {};

    const head = mk('div', 'gp-head');
    const title = mk('div', 'gp-title');
    title.appendChild(mk('span', 'gp-kind gp-kind-' + (node.node_type || 'concept'), node.node_type || 'concept'));
    title.appendChild(mk('span', 'gp-name', node.label || node.id));
    const closeBtn = mk('button', 'gp-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      close();
    });
    head.appendChild(title);
    head.appendChild(closeBtn);
    host.appendChild(head);

    const body = mk('div', 'gp-body');
    const segs = nodeMessageSegments(node);
    if (!segs.length) {
      body.appendChild(mk('p', 'gp-empty', 'No transcript messages are linked to this node yet.'));
    } else {
      body.appendChild(
        mk(
          'p',
          'gp-note',
          segs.length === 1
            ? 'Mentioned in 1 message — click to dig in.'
            : 'Mentioned in ' + segs.length + ' messages — click one to dig in.',
        ),
      );
      segs.forEach((seg) => {
        const line = model.transcript.get(seg);
        const row = mk('button', 'gp-msg clickable');
        row.type = 'button';
        row.appendChild(mk('span', 'gp-who', line.who || 'Speaker'));
        row.appendChild(mk('span', 'gp-text', line.text || ''));
        row.addEventListener('click', (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          close();
          selectAndExplain(seg);
        });
        body.appendChild(row);
      });
    }
    host.appendChild(body);
  }

  // Dismiss an open graph node popover (Escape / modal close). Returns true iff one was
  // open, so the Escape handler can swallow that key before falling through to the modal.
  function closeGraphPopover() {
    if (typeof window !== 'undefined' && window.AizenGraph && window.AizenGraph.closePopover && els.graph) {
      return window.AizenGraph.closePopover(els.graph);
    }
    return false;
  }

  // Reflect socket health on the sidebar connection chip (purely cosmetic).
  function setConn(state, text) {
    if (!els.connChip) return;
    els.connChip.classList.remove('online', 'offline');
    if (state) els.connChip.classList.add(state);
    const t = els.connChip.querySelector('.conn-text');
    if (t && text) t.textContent = text;
  }

  // Shared source row (reused by inline answers, the side panel, and the F1
  // follow-up thread). Web citations render as links (INV-1/2); the asker's OWN
  // grounding — Obsidian notes / local files / pasted notes (no url) — renders as a
  // labeled chip so it's clear an answer was grounded in their connected sources.
  // Owned chips are ALWAYS shown (not subject to the web `limit`) so a vault-grounded
  // answer never hides the fact it used the vault.
  function buildSourceRow(sources, className, limit) {
    const src = document.createElement('div');
    src.className = className;
    const list = sources || [];
    list
      .filter((s) => s && s.url)
      .slice(0, limit || 3)
      .forEach((s) => {
        const a = document.createElement('a');
        a.href = s.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = s.title || s.url;
        src.appendChild(a);
        src.appendChild(document.createTextNode(' '));
      });
    list
      .filter((s) => s && !s.url) // user / file / obsidian
      .slice(0, 4)
      .forEach((s) => {
        src.appendChild(sourceChip(s));
        src.appendChild(document.createTextNode(' '));
      });
    return src;
  }

  // Inline SVG provenance icons for BYO-source citations (vault / file / note),
  // matching the UI's stroke-icon set instead of emoji.
  const SVG_OBSIDIAN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20"/></svg>';
  const SVG_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M7 3h7l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>';
  const SVG_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

  // A non-link citation for the asker's own source, icon'd by provenance.
  function sourceChip(s) {
    const span = document.createElement('span');
    const type = s.type || 'user';
    span.className = 'src-chip src-chip-' + type;
    const ico = document.createElement('span');
    ico.className = 'src-chip-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.innerHTML = type === 'obsidian' ? SVG_OBSIDIAN : type === 'file' ? SVG_FILE : SVG_NOTE;
    const fallback = type === 'obsidian' ? 'vault note' : type === 'file' ? 'file' : 'your note';
    span.appendChild(ico);
    span.appendChild(document.createTextNode(s.title || fallback));
    if (s.snippet) span.title = s.snippet; // hover shows the grounding excerpt
    return span;
  }

  // The compact answer shown directly beneath a finalized question line.
  function buildInlineAnswer(state) {
    const box = document.createElement('div');
    box.className = 'inline-answer';
    if (state.state === 'loading') {
      box.classList.add('muted');
      box.textContent = 'Answering…';
      return box;
    }
    // Streaming (#1): show the explanation's meaning / the answer accumulated so far.
    if (state.state === 'streaming' && state.ex) {
      const p = document.createElement('p');
      p.className = 'ia-answer';
      if (state.ex.is_question) {
        const live = state.answerText || '';
        p.textContent = live || 'Answering…';
        if (!live) p.classList.add('muted');
      } else {
        p.textContent = state.ex.explanation;
      }
      box.appendChild(p);
      return box;
    }
    const ex = state.ex;
    if (!ex) {
      box.classList.add('muted');
      box.textContent = 'No answer.';
      return box;
    }
    if (ex.is_question) {
      const p = document.createElement('p');
      p.className = 'ia-answer';
      if (ex.answer) {
        p.textContent = ex.answer;
      } else {
        p.textContent = 'No confident answer found from the web sources.';
        p.classList.add('muted');
      }
      box.appendChild(p);
      if (ex.sources && ex.sources.length) {
        box.appendChild(buildSourceRow(ex.sources, 'ia-src', 3));
      }
    } else {
      // Not a question (e.g. a manual click on a statement): show the meaning.
      const p = document.createElement('p');
      p.className = 'ia-answer';
      p.textContent = ex.explanation;
      box.appendChild(p);
    }
    return box;
  }

  // Click a final sentence → show its full breakdown in the side panel (and
  // request the explanation if it wasn't auto-answered).
  els.transcript.addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // let source links click through
    const lineEl = e.target.closest('.line.clickable');
    if (!lineEl) return;
    selectAndExplain(lineEl.dataset.segmentId);
  });

  // Select a transcript sentence and show its full breakdown in the side panel
  // (requesting the explanation if it wasn't auto-answered). Shared by a transcript
  // click AND a click on a concept card / insight evidence chip, so a deep-dive from
  // anywhere reuses the same web-grounded explain flow.
  function selectAndExplain(id) {
    const line = model.transcript.get(id);
    if (!line) return;
    selected = id;
    // If a focus popup is open over the live cards (e.g. the user clicked an insight's
    // "evidence" chip inside the Insights popup, or a sentence in the Transcript popup),
    // SWAP it to the Explanation popup so the deep-dive lands front-and-centre. We used
    // to closeModal() here, which dropped the breakdown into the dashboard's explanation
    // card — almost always scrolled off-screen — so the click looked like it did nothing.
    if (openModalKind && FOCUS_SECTIONS[openModalKind] && openModalKind !== 'explanation') {
      openModal('explanation');
    }
    const exState = model.explanations.get(id);
    if (exState && exState.state === 'done') {
      renderExplanation(exState.ex);
    } else if (exState && exState.state === 'streaming' && exState.ex) {
      renderExplanation(exState.ex, { streaming: true, answerText: exState.answerText || '' });
    } else if (exState && exState.state === 'loading') {
      showExplanationLoading(line.text);
    } else {
      showExplanationLoading(line.text);
      requestExplain(id, line.text);
    }
    renderTranscript();
  }

  // Keep the explanation tab's freshly-produced content in view. The breakdown
  // panel (#explanation) scrolls internally (capped height, overflow-y:auto),
  // while the follow-up thread below it grows the page — so "scroll into view"
  // differs by target:
  //   'top'      — a new sentence breakdown was rendered; start it at the
  //                sentence rather than wherever the previous (possibly longer)
  //                explanation had been scrolled to.
  //   'followup' — a Q→A was appended; bring the newest exchange into view.
  // Guarded so an environment without layout/scroll APIs (the headless DOM test
  // harness) is a silent no-op rather than a throw.
  function scrollExplanation(where) {
    if (where === 'followup') {
      const thread = els.followupThread;
      const latest = thread && thread.children[thread.children.length - 1];
      if (latest && typeof latest.scrollIntoView === 'function') {
        latest.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }
    const panel = els.explanation;
    if (panel && typeof panel.scrollTo === 'function') {
      panel.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function showExplanationLoading(sentence) {
    els.explanation.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'explain';
    div.innerHTML = `<p class="sentence"></p><p class="loading">Explaining…</p>`;
    div.querySelector('.sentence').textContent = sentence;
    els.explanation.appendChild(div);
    scrollExplanation('top');
  }

  // `opts.streaming` renders the in-progress view (#1): the answer shows the text
  // accumulated so far (`opts.answerText`) and its <p> is cached in `streamAnswerNode`
  // so later deltas update it in place; sources, the degraded note, and the
  // scroll-to-top are deferred to the final (non-streaming) render.
  function renderExplanation(ex, opts) {
    if (!ex || ex.segment_id !== selected) return; // ignore stale/late replies
    opts = opts || {};
    const streaming = !!opts.streaming;
    // A fresh render replaces the panel, so any previously-cached streaming node is
    // gone — drop the reference (re-set below if THIS render is itself streaming).
    if (streamAnswerSeg === ex.segment_id) {
      streamAnswerNode = null;
      streamAnswerSeg = null;
    }
    els.explanation.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'explain';

    const sentence = document.createElement('p');
    sentence.className = 'sentence';
    sentence.textContent = ex.sentence;
    div.appendChild(sentence);

    const meaning = document.createElement('p');
    meaning.className = 'meaning';
    meaning.textContent = ex.explanation;
    div.appendChild(meaning);

    if (ex.breakdown && ex.breakdown.length) {
      const h = document.createElement('h3');
      h.textContent = 'Word breakdown';
      div.appendChild(h);
      const ul = document.createElement('ul');
      ul.className = 'breakdown';
      ex.breakdown.forEach((b) => {
        const li = document.createElement('li');
        const w = document.createElement('span');
        w.className = 'w';
        w.textContent = b.word;
        li.appendChild(w);
        li.appendChild(document.createTextNode(' — ' + b.meaning));
        ul.appendChild(li);
      });
      div.appendChild(ul);
    }

    if (ex.is_question) {
      const h = document.createElement('h3');
      h.textContent = 'Answer';
      div.appendChild(h);
      const ans = document.createElement('p');
      ans.className = 'answer';
      const live = opts.answerText || '';
      if (streaming) {
        ans.textContent = live || 'Answering…';
        if (!live) ans.classList.add('muted');
        streamAnswerNode = ans; // later deltas update this node directly
        streamAnswerSeg = ex.segment_id;
      } else {
        // Final: keep the streamed text if the final result lacks one (degraded).
        const finalText = ex.answer || live;
        ans.textContent = finalText || 'No confident answer found from the web sources.';
        if (!finalText) ans.classList.add('muted');
      }
      div.appendChild(ans);

      if (!streaming) div.appendChild(buildSourceRow(ex.sources, 'src', 3));
    }

    if (!streaming && ex.state === 'degraded') {
      const note = document.createElement('p');
      note.className = 'degraded';
      note.textContent =
        'Demo/degraded — add ANTHROPIC_API_KEY (and TAVILY_API_KEY) to .env for real explanations.';
      div.appendChild(note);
    }

    els.explanation.appendChild(div);
    if (!streaming) scrollExplanation('top'); // don't fight the reader while tokens stream
  }

  // Apply a streamed answer fragment to the explain panel (#1). Updates the cached
  // answer node in place when it's the selected sentence; otherwise just accumulates.
  function applyExplainAnswerDelta(segmentId, text) {
    const st = model.explanations.get(segmentId);
    if (!st) return;
    st.answerText = (st.answerText || '') + (text || '');
    if (st.state !== 'done') st.state = 'streaming';
    if (segmentId !== selected || !st.ex) return;
    if (streamAnswerNode && streamAnswerSeg === segmentId && st.ex.is_question) {
      streamAnswerNode.classList.remove('muted');
      streamAnswerNode.textContent = st.answerText;
    } else {
      renderExplanation(st.ex, { streaming: true, answerText: st.answerText });
    }
  }

  function renderExplainError(segmentId, message) {
    if (segmentId !== selected) return;
    els.explanation.innerHTML = `<div class="explain"><p class="degraded"></p></div>`;
    els.explanation.querySelector('.degraded').textContent = 'Could not explain: ' + message;
  }

  // ---- F1: type a follow-up question after a sentence is explained ----------
  // The follow-up attaches to the currently selected sentence (or the most recent
  // final line) and is answered by the server in the context of that sentence +
  // the surrounding transcript. The thread of Q→A pairs renders above the input.

  function hasAnyExplanation() {
    for (const st of model.explanations.values()) if (st.state === 'done') return true;
    return false;
  }

  // Enable the follow-up input only once there's a sentence with context to
  // attach to (at least one explanation). Guarded for absent markup.
  function updateFollowupEnabled() {
    const enabled = hasAnyExplanation();
    if (els.followupInput) els.followupInput.disabled = !enabled;
    if (els.followupSend) els.followupSend.disabled = !enabled;
  }

  // The most recent FINAL segment id (Map preserves insertion order).
  function mostRecentFinalId() {
    let id = null;
    for (const [k, line] of model.transcript) if (line.is_final) id = k;
    return id;
  }

  // Which sentence a follow-up attaches to: the selected line if it's final, else
  // the most recent final line.
  function followupSegmentId() {
    if (selected) {
      const line = model.transcript.get(selected);
      if (line && line.is_final) return selected;
    }
    return mostRecentFinalId();
  }

  function renderFollowups() {
    if (!els.followupThread) return;
    els.followupThread.innerHTML = '';
    for (const fu of model.followups) {
      const item = document.createElement('div');
      item.className = 'fu-item';

      const q = document.createElement('div');
      q.className = 'fu-q';
      q.textContent = fu.question;
      item.appendChild(q);

      const a = document.createElement('div');
      a.className = 'fu-a';
      if (fu.state === 'loading') {
        a.classList.add('muted');
        a.textContent = 'Answering…';
      } else if (fu.state === 'streaming') {
        // (#1) the answer accumulated so far; its <p> is cached so deltas update in place.
        const p = document.createElement('p');
        p.className = 'fu-answer';
        const live = fu._streamText || '';
        p.textContent = live || 'Answering…';
        if (!live) p.classList.add('muted');
        a.appendChild(p);
        streamFuNode = p;
        streamFuAsk = fu.ask_id;
      } else if (fu.state === 'error') {
        a.classList.add('muted');
        a.textContent = 'Could not answer: ' + (fu.error || 'unknown error');
      } else {
        const ans = fu.answer || {};
        const p = document.createElement('p');
        p.className = 'fu-answer';
        // Prefer the final answer; if it has none but degraded mid-stream, keep the
        // text we already streamed rather than retracting it.
        const finalText = ans.answer || (ans.state === 'degraded' ? fu._streamText || '' : '');
        if (finalText) {
          p.textContent = finalText;
        } else {
          p.textContent = 'No confident answer found.';
          p.classList.add('muted');
        }
        a.appendChild(p);
        if (ans.sources && ans.sources.length) {
          a.appendChild(buildSourceRow(ans.sources, 'ia-src', 3));
        }
        if (ans.state === 'degraded') {
          const note = document.createElement('p');
          note.className = 'degraded';
          note.textContent =
            'Demo/degraded — add ANTHROPIC_API_KEY (and TAVILY_API_KEY) to .env for real answers.';
          a.appendChild(note);
        }
      }
      item.appendChild(a);
      els.followupThread.appendChild(item);
    }
    if (model.followups.length) scrollExplanation('followup');
  }

  // The conversation context a follow-up is answered against, gathered from the
  // client's OWN live model. We send it WITH the ask so a follow-up survives a WS
  // reconnect: each socket is a fresh server session whose context buffer starts
  // empty, but the browser keeps the whole transcript — so without shipping the
  // context here, a context-dependent follow-up ("what did he mean by that?")
  // asked after any reconnect/restart would reach a session that has no memory of
  // the sentence and come back unanswered. `sentence` is the line the follow-up
  // attaches to; `transcript` is the recent final lines, oldest→newest.
  function followupContext(segmentId) {
    const about = model.transcript.get(segmentId);
    const sentence = about && about.is_final ? about.text : '';
    return { sentence, transcript: recentTranscript() }; // shared, capped to bound frame size
  }

  function submitFollowup() {
    if (!els.followupInput) return;
    const question = els.followupInput.value.trim();
    if (!question) return;
    const segmentId = followupSegmentId();
    if (!segmentId) return; // nothing explained yet (input is disabled in this state)
    askSeq += 1;
    const askId = 'ask_' + askSeq;
    const fu = { ask_id: askId, segment_id: segmentId, question, state: 'loading' };
    model.followups.push(fu);
    els.followupInput.value = '';
    renderFollowups();
    if (ws && ws.readyState === WebSocket.OPEN) {
      const ctx = followupContext(segmentId);
      ws.send(
        JSON.stringify({
          type: 'ask',
          segment_id: segmentId,
          question,
          ask_id: askId,
          sentence: ctx.sentence,
          transcript: ctx.transcript,
          // The "current query" for retrieval (S0) is the typed follow-up question.
          user_sources: userSourcesForSend(question),
          fast: fastAnswersEnabled(),
          web_search: webSearchEnabled(),
        }),
      );
      // Final safety net: if no answer/error frame ever comes back (a wedged
      // upstream call the server's own guard somehow misses, or a silently dead
      // socket that never fires `onclose`), fail the follow-up rather than spin on
      // "Answering…" forever. Cleared the moment a reply arrives or the socket drops.
      fu._timer = setTimeout(() => {
        if (fu.state === 'loading') {
          fu.state = 'error';
          fu.error = 'Timed out waiting for an answer — please try again.';
          renderFollowups();
        }
      }, FOLLOWUP_UI_TIMEOUT_MS);
    } else {
      fu.state = 'error';
      fu.error = 'Not connected — reconnecting.';
      renderFollowups();
    }
  }

  // Clear a follow-up's pending UI-timeout timer (it has been resolved or failed).
  function clearFollowupTimer(fu) {
    if (fu && fu._timer) {
      clearTimeout(fu._timer);
      fu._timer = null;
    }
  }

  // Fail any in-flight (still "Answering…") follow-ups. Called when the socket
  // drops: the reply will never arrive on the new socket (it's a different server
  // session and the in-flight answer promise is gone), so leaving them spinning
  // forever reads as "the follow-up did nothing". The user can simply re-ask.
  function failPendingFollowups(message) {
    let changed = false;
    for (const fu of model.followups) {
      if (fu.state === 'loading' || fu.state === 'streaming') {
        clearFollowupTimer(fu);
        fu.state = 'error';
        fu.error = message;
        if (streamFuAsk === fu.ask_id) {
          streamFuNode = null;
          streamFuAsk = null;
        }
        changed = true;
      }
    }
    if (changed) renderFollowups();
  }

  // Apply a streamed follow-up answer fragment (#1). Updates the cached <p> in place
  // once it exists; the first delta flips 'loading'→'streaming' and rebuilds once so
  // the node (and its cache ref) are created.
  function applyAnswerDelta(askId, text) {
    const fu = model.followups.find((f) => f.ask_id === askId);
    if (!fu || fu.state === 'done' || fu.state === 'error') return;
    fu._streamText = (fu._streamText || '') + (text || '');
    if (fu.state !== 'streaming') {
      fu.state = 'streaming';
      renderFollowups(); // creates the streaming <p> + caches streamFuNode
      return;
    }
    if (streamFuNode && streamFuAsk === askId) {
      streamFuNode.classList.remove('muted');
      streamFuNode.textContent = fu._streamText;
    } else {
      renderFollowups();
    }
  }

  function applyAnswer(askId, answer) {
    const fu = model.followups.find((f) => f.ask_id === askId);
    if (!fu) return;
    clearFollowupTimer(fu);
    fu.state = 'done';
    fu.answer = answer; // a FollowupAnswer {answer, sources, state, ...}
    if (streamFuAsk === askId) {
      streamFuNode = null;
      streamFuAsk = null;
    }
    renderFollowups();
    refreshFocusData(); // a follow-up's sources may add to an open Sources popup
  }

  function applyAnswerError(askId, message) {
    const fu = model.followups.find((f) => f.ask_id === askId);
    if (!fu) return;
    clearFollowupTimer(fu);
    fu.state = 'error';
    fu.error = message;
    if (streamFuAsk === askId) {
      streamFuNode = null;
      streamFuAsk = null;
    }
    renderFollowups();
  }

  if (els.followupForm) {
    els.followupForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitFollowup();
    });
  }
  updateFollowupEnabled();

  // ---- websocket -----------------------------------------------------------
  // The socket carries mic audio up and transcript/explanation envelopes back. It
  // is long-lived and reused across every Start/Stop of the mic, so a single
  // dropped socket (proxy/idle timeout, server restart, brief network blip) must
  // NOT wedge the app: without auto-reconnect the only recovery was a full page
  // refresh — exactly the "won't start recording again" symptom. We rebuild the
  // socket with capped backoff; the server answers each fresh session with a
  // `status` frame that re-enables the buttons.
  let ws;
  let reconnectTimer = null;
  let reconnectDelay = 500; // ms; doubles per attempt up to a ceiling
  let giveUpReconnect = false; // set on a fatal server error (e.g. consent refused)

  function scheduleReconnect() {
    if (reconnectTimer || giveUpReconnect) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000); // back off, cap at 5s
  }

  function connect() {
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${wsProto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      reconnectDelay = 500; // reset backoff once we're reconnected
      els.status.textContent = 'connected';
      setConn('online', 'Connected');
    };
    ws.onclose = () => {
      setButtonsEnabled(false);
      stopCapture();
      // The socket dropped — any follow-up still waiting on this session will
      // never be answered on the reconnected one. Fail them instead of leaving
      // them stuck on "Answering…".
      failPendingFollowups('Connection dropped before the answer arrived — ask again.');
      if (giveUpReconnect) {
        els.status.textContent = 'disconnected';
        setConn('offline', 'Disconnected');
        return;
      }
      els.status.textContent = 'reconnecting…';
      setConn('offline', 'Reconnecting…');
      scheduleReconnect();
    };
    ws.onerror = () => {
      // An error is always followed by a close event, which drives the reconnect.
      els.status.textContent = 'connection error';
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'status') {
        mode = msg.mode;
        if (msg.sessionId) currentSessionId = msg.sessionId;
        const p = msg.providers || {};
        wsProviderStatus = p; // live provider status for the Providers popup
        // Just the LIVE/DEMO badge — the per-provider breakdown moved into the
        // Providers popup (click "Providers" in the sidebar).
        const tag = mode === 'live' ? '<span class="live">LIVE</span>' : '<span class="demo">DEMO</span>';
        els.status.innerHTML = tag;
        if (mode === 'live') {
          setButtonsEnabled(true);
          els.hint.textContent =
            'Capture your mic, your computer’s audio, or both, then speak/play audio. ' +
            'Questions are answered automatically when speech pauses; ' +
            'click any finished sentence for a full word-by-word breakdown.';
        } else {
          setButtonsEnabled(false);
          els.hint.textContent =
            'Demo mode: no Deepgram key, so a canned clip drives the transcript. ' +
            'Click a finished sentence to explain it' +
            (p.llm === 'anthropic'
              ? ' with the real Anthropic model.'
              : ' (add ANTHROPIC_API_KEY + DEEPGRAM_API_KEY to .env for the full live experience).');
        }
      } else if (msg.type === 'envelope') {
        foldEnvelope(msg.env); // renders the affected surface itself (transcript or an intel panel)
      } else if (msg.type === 'explanation_partial') {
        // (#1) hop-1 result: paint the explanation + breakdown immediately; the
        // grounded answer (if any) streams in via answer_delta frames next.
        const ex = msg.explanation;
        if (ex && ex.segment_id) {
          const prev = model.explanations.get(ex.segment_id);
          const answerText = prev && prev.answerText ? prev.answerText : '';
          model.explanations.set(ex.segment_id, { state: 'streaming', ex, answerText });
          renderTranscript();
          if (ex.segment_id === selected) renderExplanation(ex, { streaming: true, answerText });
        }
      } else if (msg.type === 'answer_delta') {
        // (#1) a streamed answer fragment — for the explain panel (segment_id) or a
        // typed follow-up (ask_id).
        if (msg.ask_id) applyAnswerDelta(msg.ask_id, msg.text);
        else if (msg.segment_id) applyExplainAnswerDelta(msg.segment_id, msg.text);
      } else if (msg.type === 'explanation') {
        const ex = msg.explanation;
        if (ex && ex.segment_id) {
          // Keep streamed answer text if the final result degraded without one
          // (don't retract text the reader already saw).
          const prev = model.explanations.get(ex.segment_id);
          if (!ex.answer && prev && prev.answerText && ex.state === 'degraded') {
            ex.answer = prev.answerText;
          }
          if (streamAnswerSeg === ex.segment_id) {
            streamAnswerNode = null;
            streamAnswerSeg = null;
          }
          model.explanations.set(ex.segment_id, { state: 'done', ex });
          renderTranscript(); // inline answer under the line
          if (ex.segment_id === selected) renderExplanation(ex); // full breakdown in panel
          updateFollowupEnabled(); // a sentence is explained → enable follow-ups
          refreshFocusData(); // new sources may have arrived → refresh an open Sources popup
        }
      } else if (msg.type === 'answer') {
        // F1 reply: a typed follow-up's grounded answer, matched by ask_id.
        if (msg.ask_id) applyAnswer(msg.ask_id, msg.answer);
      } else if (msg.type === 'answer_error') {
        if (msg.ask_id) applyAnswerError(msg.ask_id, msg.message);
      } else if (msg.type === 'explain_error') {
        if (msg.segment_id) {
          // drop the loading state + allow a retry on next click.
          model.explanations.delete(msg.segment_id);
          requested.delete(msg.segment_id);
          renderTranscript();
        }
        renderExplainError(msg.segment_id, msg.message);
      } else if (msg.type === 'error') {
        // A fatal, session-level error (e.g. consent refused). Reconnecting would
        // just be refused again, so stop retrying and surface it.
        giveUpReconnect = true;
        els.status.textContent = 'error: ' + msg.message;
      }
    };
  }

  connect();

  // Paint the intelligence panels' empty states on load (they fill as F02 arrives).
  renderConcepts();
  renderInsights();
  renderSummary();
  renderGraph();

  // ---- audio capture (mic / computer / both) -------------------------------
  // One capture engine, three sources. Each source's MediaStream is wired into a
  // shared ScriptProcessor (Web Audio sums multiple inputs), downsampled to 16 kHz
  // PCM16 mono, and streamed to the server as binary WS frames — identical to what
  // Deepgram expects, so the live STT path is unchanged regardless of source.
  //
  //   mic  → getUserMedia (the microphone)
  //   sys  → getDisplayMedia({audio}) (a tab / "Entire screen" with audio shared)
  //   both → mic + sys mixed together (each attenuated to avoid clipping)
  let audioCtx, processor, sink, capturing = false, starting = false;
  let activeStreams = []; // MediaStreams to stop on teardown
  let activeMode = null; // 'mic' | 'sys' | 'both'

  // UI labels per button, idle vs recording.
  // Icon + label are tracked separately so updateButtons() can refresh the
  // <span class="btn-ico"> / <span class="btn-txt"> structure in place (the CSS
  // hides .btn-txt on mobile for icon-only pills) instead of flattening the
  // button to plain text.
  // Inline SVG icons (Lucide-style) so the capture buttons match the rest of the
  // UI's icon set instead of emoji. Injected via innerHTML by updateButtons().
  const ICO_MIC = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/></svg>';
  const ICO_MONITOR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
  const ICO_WAVES = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4M7 6v12M11 9v6M15 5v14M19 8v8"/></svg>';
  const ICO_STOP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  const BTN = {
    mic: { el: () => els.mic, idleIco: ICO_MIC, idleTxt: 'Mic', recIco: ICO_STOP, recTxt: 'Stop mic' },
    sys: { el: () => els.sys, idleIco: ICO_MONITOR, idleTxt: 'Computer audio', recIco: ICO_STOP, recTxt: 'Stop computer' },
    both: { el: () => els.both, idleIco: ICO_WAVES, idleTxt: 'Mic + computer', recIco: ICO_STOP, recTxt: 'Stop both' },
  };

  function floatToPcm16Downsampled(input, inRate) {
    const ratio = inRate / 16000;
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      // simple box average over the source window (cheap anti-alias)
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let n = 0;
      for (let j = start; j < end; j++) {
        sum += input[j];
        n++;
      }
      const sample = n ? sum / n : input[start] || 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return out;
  }

  function getMicStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  }

  // Computer/system audio. getDisplayMedia needs a video request for the picker
  // to appear; we only consume the audio track. The user must pick a Tab or
  // "Entire screen" AND tick "Share tab/system audio" — a Window has none.
  //
  // IMPORTANT: we do NOT stop the video track. In Chrome the audio + video tracks
  // of a display capture share one session; stopping the video track ends the
  // session, which fires 'ended' on the audio track and kills the capture. So we
  // leave the (unused) video track running — it's torn down in stopCapture() with
  // everything else. We just blank it (enabled=false) to cut needless work.
  async function getSystemStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error(window.isSecureContext === false ? 'insecure' : 'unsupported');
    }
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (s.getAudioTracks().length === 0) {
      s.getTracks().forEach((t) => t.stop());
      throw new Error('no-audio');
    }
    s.getVideoTracks().forEach((t) => { t.enabled = false; }); // keep alive, but idle
    return s;
  }

  async function startCapture(targetMode) {
    // Guard against re-entrant clicks: a double-tap (or clicking a 2nd source while
    // the first is still opening) must not spawn two captures that leak each other's
    // streams. One start runs at a time; extra clicks are ignored until it settles.
    if (starting) return;
    starting = true;
    try {
      await doStartCapture(targetMode);
    } finally {
      starting = false;
    }
  }

  async function doStartCapture(targetMode) {
    if (capturing) await stopCapture(); // mutually exclusive — tear down fully first

    let streams;
    try {
      if (targetMode === 'mic') streams = [await getMicStream()];
      else if (targetMode === 'sys') streams = [await getSystemStream()];
      else {
        // 'both': acquire the mic first, then the system stream. If the system
        // picker is cancelled/denied, stop the already-granted mic so it doesn't
        // leak (mic light stuck on) — `activeStreams` isn't set yet to clean it up.
        const mic = await getMicStream();
        try {
          streams = [mic, await getSystemStream()];
        } catch (e) {
          mic.getTracks().forEach((t) => t.stop());
          throw e;
        }
      }
    } catch (e) {
      els.hint.textContent = captureError(targetMode, e);
      return;
    }

    activeStreams = streams;
    activeMode = targetMode;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    // route through a muted sink so the processor runs without echoing to speakers
    sink = audioCtx.createGain();
    sink.gain.value = 0;

    // Mix all source streams into the one processor. Attenuate when mixing so the
    // summed signal doesn't clip.
    const perSourceGain = streams.length > 1 ? 0.7 : 1.0;
    let wiredAudioTracks = 0;
    for (const st of streams) {
      const aTracks = st.getAudioTracks();
      if (aTracks.length === 0) continue;
      wiredAudioTracks += aTracks.length;
      const node = audioCtx.createMediaStreamSource(st);
      const gain = audioCtx.createGain();
      gain.gain.value = perSourceGain;
      node.connect(gain);
      gain.connect(processor);
      // If the user ends sharing (browser "Stop sharing" bar), tear capture down.
      aTracks.forEach((t) => t.addEventListener('ended', () => {
        console.warn('[capture] audio track ended (' + (t.label || 'unnamed') + ') — stopping');
        if (capturing) stopCapture();
      }));
    }
    console.log(
      '[capture] start mode=' + targetMode + ' ctx.sampleRate=' + audioCtx.sampleRate +
      ' ctx.state=' + audioCtx.state + ' audioTracks=' + wiredAudioTracks,
    );
    if (wiredAudioTracks === 0) {
      // No audio anywhere (e.g. shared a Window, or unticked "share audio").
      await stopCapture();
      els.hint.textContent = captureError(targetMode, new Error('no-audio'));
      return;
    }
    processor.connect(sink);
    sink.connect(audioCtx.destination);
    let framesSent = 0;
    processor.onaudioprocess = (e) => {
      if (!capturing || ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = floatToPcm16Downsampled(input, audioCtx.sampleRate);
      ws.send(pcm.buffer);
      if (framesSent === 0) console.log('[capture] first PCM frame sent (' + pcm.length + ' samples)');
      framesSent++;
    };
    capturing = true;

    // A context created after `await getUserMedia` is past the click's synchronous
    // gesture, and some browsers then start it 'suspended' — the ScriptProcessor's
    // onaudioprocess never fires, so no PCM is sent (no transcript, "not recording").
    // Resume explicitly and await it so the first frame after a stop→start cycle
    // actually flows instead of needing a page refresh.
    if (audioCtx.state === 'suspended' && audioCtx.resume) {
      try {
        await audioCtx.resume();
      } catch {
        /* resume may reject without a fresh gesture; the graph runs once resumed */
      }
    }
    console.log('[capture] ctx.state after resume=' + (audioCtx ? audioCtx.state : 'gone'));
    updateButtons();
  }

  // Returns a promise that resolves when the audio graph is fully torn down, so a
  // restart can await it and build its fresh context from a clean slate (rather than
  // racing a half-closed one or piling up AudioContexts, which browsers cap).
  function stopCapture() {
    capturing = false;
    if (processor) processor.onaudioprocess = null;
    try { if (processor) processor.disconnect(); } catch {}
    try { if (sink) sink.disconnect(); } catch {}
    activeStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    activeStreams = [];
    const ctx = audioCtx;
    audioCtx = processor = sink = null;
    activeMode = null;
    updateButtons();
    if (ctx && ctx.state !== 'closed') {
      return ctx.close().catch(() => {});
    }
    return Promise.resolve();
  }

  function captureError(targetMode, e) {
    const what = targetMode === 'mic' ? 'Microphone' : 'Computer audio';
    console.warn('[capture] ' + targetMode + ' failed:', e && (e.name + ': ' + e.message), e);
    if (e && e.message === 'insecure') {
      return 'Computer audio needs a secure page. Open the app via http://localhost:' +
        location.port + ' (not an IP/hostname) or use HTTPS.';
    }
    if (e && e.message === 'unsupported') return 'Computer audio capture is not supported in this browser.';
    if (e && e.message === 'no-audio') {
      return 'No audio was shared. In the picker choose a browser Tab or "Entire screen" ' +
        'and tick "Share tab audio" / "Share system audio" — sharing a Window has no audio.';
    }
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
      return what + ' sharing was cancelled or denied.';
    }
    return what + ' capture failed: ' + ((e && e.message) || e);
  }

  // Reflect capture state on all three buttons (only the active one shows "Stop").
  function updateButtons() {
    for (const mode of Object.keys(BTN)) {
      const cfg = BTN[mode];
      const btn = cfg.el();
      if (!btn) continue;
      const active = capturing && activeMode === mode;
      const ico = btn.querySelector('.btn-ico');
      const txt = btn.querySelector('.btn-txt');
      if (ico && txt) {
        ico.innerHTML = active ? cfg.recIco : cfg.idleIco;
        txt.textContent = active ? cfg.recTxt : cfg.idleTxt;
      } else {
        // Fallback if the markup ever omits the spans: keep the old flat label.
        btn.innerHTML = active ? cfg.recIco + ' ' + cfg.recTxt : cfg.idleIco + ' ' + cfg.idleTxt;
      }
      btn.classList.toggle('recording', active);
    }
  }

  function setButtonsEnabled(enabled) {
    for (const mode of Object.keys(BTN)) {
      const btn = BTN[mode].el();
      if (btn) btn.disabled = !enabled;
    }
  }

  function toggle(mode) {
    if (capturing && activeMode === mode) stopCapture();
    else startCapture(mode);
  }

  if (els.mic) els.mic.addEventListener('click', () => toggle('mic'));
  if (els.sys) els.sys.addEventListener('click', () => toggle('sys'));
  if (els.both) els.both.addEventListener('click', () => toggle('both'));
  updateButtons();

  // ---- dashboard chrome (search / sidebar drawer / nav) --------------------
  // Purely presentational glue. None of it touches capture, transcription, or
  // the explain pipeline, and every handler is guarded for absent elements.

  // Top-bar search filters the rendered transcript (see renderTranscript()).
  if (els.search) {
    els.search.addEventListener('input', () => {
      filterText = els.search.value.trim().toLowerCase();
      renderTranscript();
    });
  }

  // Mobile off-canvas sidebar.
  function closeDrawer() {
    document.body.classList.remove('nav-open');
    if (els.navToggle) els.navToggle.setAttribute('aria-expanded', 'false');
  }
  function toggleDrawer() {
    const open = document.body.classList.toggle('nav-open');
    if (els.navToggle) els.navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (els.navToggle) els.navToggle.addEventListener('click', toggleDrawer);
  if (els.navBackdrop) els.navBackdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // Sidebar nav: highlight the clicked item and either open an exclusive popup or
  // (for "Live Session") show the full dashboard, then collapse the drawer on
  // mobile. data-modal items (Providers / Settings / Transcript / Explanation /
  // Activity / Sources) open a popup; everything else scrolls to data-target.
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      const modalKind = item.getAttribute('data-modal');
      if (modalKind) {
        e.preventDefault();
        openModal(modalKind);
        navItems.forEach((n) => n.classList.remove('active'));
        item.classList.add('active');
        closeDrawer();
        return;
      }
      // A non-modal item ("Live Session"): keep the whole dashboard in place. If a
      // focus popup is open, close it first so everything is shown again.
      closeModal();
      const targetId = item.getAttribute('data-target');
      const target = targetId && document.getElementById(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      navItems.forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      closeDrawer();
    });
  });

  // ---- theme: light (default) / dark toggle --------------------------------
  // The active theme lives as a `data-theme` attribute on <html>; the inline
  // <head> script already applied any saved choice before first paint (so there
  // is no flash). Here we just wire the toggle: flip the attribute, remember the
  // choice, keep the button's a11y state in sync, and mirror the theme into the
  // pop-out window when one is open (it has its own <html>). Guarded so the core
  // flow is unaffected if the toggle markup is absent.
  const THEME_KEY = 'aizen-theme';

  // ---- Obsidian feature flag -----------------------------------------------
  // Obsidian is an OPT-IN integration: off and fully hidden by default. A slider
  // in Settings flips it on, which unhides the Obsidian connect card under
  // Sources. Persisted in localStorage like the theme so the choice survives a
  // reload (and so the on-boot vault re-connect only fires when it's enabled).
  const OBSIDIAN_KEY = 'aizen-obsidian-enabled';

  function obsidianEnabled() {
    try {
      return localStorage.getItem(OBSIDIAN_KEY) === '1';
    } catch {
      return false; // storage blocked (private mode) → stay off (the safe default)
    }
  }

  function setObsidianEnabled(on, persist) {
    if (persist) {
      try {
        localStorage.setItem(OBSIDIAN_KEY, on ? '1' : '0');
      } catch {
        /* storage blocked (private mode) — the choice just won't survive reload */
      }
    }
    // Turning it OFF must truly disable it: drop any connected vault so its notes
    // stop grounding answers and nothing Obsidian-related lingers while hidden.
    if (!on && model.obsidian.status !== 'idle') disconnectObsidian();
    // Reflect the change immediately if a popup that surfaces Obsidian is open.
    if (openModalKind === 'sources' || openModalKind === 'settings') renderOpenModal();
  }

  // ---- Answering preferences (ride every explain/ask frame) ----------------
  // Two settings toggles, persisted in localStorage like the theme so they survive
  // a reload, and shipped with each request (mirroring user_sources) so the choice
  // survives a WS reconnect with no server-side session state:
  //   • Fast answers (Settings → Performance): answer as fast as possible — the
  //     server runs Tavily at 'fast' depth, fewer sources, tighter timeout. Off by
  //     default (matches today's behaviour). See PERFORMANCE_RESEARCH.md §4.
  //   • Web search (Providers → Web search): turn the web lookup OFF so answers lean
  //     on the model + your own connected sources only. ON by default.
  const FAST_KEY = 'aizen-fast-answers';
  const WEBSEARCH_KEY = 'aizen-web-search';

  function fastAnswersEnabled() {
    try {
      return localStorage.getItem(FAST_KEY) === '1'; // missing ⇒ off (the default)
    } catch {
      return false;
    }
  }
  function setFastAnswers(on, persist) {
    if (persist) {
      try {
        localStorage.setItem(FAST_KEY, on ? '1' : '0');
      } catch {
        /* storage blocked (private mode) — the choice just won't survive reload */
      }
    }
    // No side effects beyond the next request; the checkbox already shows its state.
  }

  function webSearchEnabled() {
    try {
      return localStorage.getItem(WEBSEARCH_KEY) !== '0'; // missing ⇒ on (the default)
    } catch {
      return true;
    }
  }
  function setWebSearch(on, persist) {
    if (persist) {
      try {
        localStorage.setItem(WEBSEARCH_KEY, on ? '1' : '0');
      } catch {
        /* storage blocked (private mode) — the choice just won't survive reload */
      }
    }
    // Refresh the Providers popup so the Web-search row's wording reflects the change.
    if (openModalKind === 'providers') renderOpenModal();
  }

  function currentTheme() {
    const root = document.documentElement;
    return root && root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function syncThemeButton(theme) {
    if (!els.themeToggle) return;
    els.themeToggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    els.themeToggle.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function setTheme(theme, persist) {
    const next = theme === 'dark' ? 'dark' : 'light';
    if (document.documentElement) document.documentElement.setAttribute('data-theme', next);
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* storage blocked (private mode) — the choice just won't survive reload */
      }
    }
    // Keep an open pop-out window on the same theme (separate document → own <html>).
    if (pipWindow && pipWindow.document && pipWindow.document.documentElement) {
      pipWindow.document.documentElement.setAttribute('data-theme', next);
    }
    syncThemeButton(next);
  }

  syncThemeButton(currentTheme()); // reflect whatever the head script applied
  if (els.themeToggle) {
    els.themeToggle.addEventListener('click', () => {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });
  }

  // ---- F2: pop the live view out into a floating window --------------------
  // Uses the Document Picture-in-Picture API: on click we MOVE (not clone) the
  // transcript + explanation panels into a small, always-on-top window. Moving
  // the live nodes keeps every cached `els.*` reference, their listeners (the
  // transcript click handler, the follow-up form), and the render loop working
  // unchanged — the same renderTranscript()/renderExplanation()/renderFollowups()
  // keep updating them in their new home, and the WS/model code stays in the
  // opener. On the PiP window's `pagehide` we move the nodes back intact.
  let pipWindow = null;
  let popoutBusy = false; // re-entrancy guard while a window is opening
  const movedPanels = []; // {el, parent, next} captured so restore is exact

  function popoutPanels() {
    return [els.cardTranscript, els.cardExplanation].filter(Boolean);
  }

  function setPopoutLabel(out) {
    if (!els.popout) return;
    const txt = els.popout.querySelector('.btn-txt');
    if (txt) txt.textContent = out ? 'Return' : 'Pop out';
    else els.popout.textContent = out ? 'Return' : 'Pop out';
    els.popout.classList.toggle('active', out);
  }

  // PiP windows start with NO styles — clone the opener's stylesheets in so it
  // looks identical.
  function copyStylesInto(win) {
    const head = win.document && win.document.head;
    if (!head) return;
    document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
      head.appendChild(node.cloneNode(true));
    });
  }

  function movePanelsInto(dest) {
    movedPanels.length = 0;
    for (const el of popoutPanels()) {
      movedPanels.push({ el, parent: el.parentNode, next: el.nextSibling });
      dest.appendChild(el); // appendChild adopts the live node into the PiP document
    }
  }

  function restorePanels() {
    for (const m of movedPanels) {
      if (m.parent) m.parent.insertBefore(m.el, m.next || null);
    }
    movedPanels.length = 0;
  }

  function onPipClosed() {
    restorePanels();
    pipWindow = null;
    setPopoutLabel(false);
  }

  // Fallback for browsers without Document PiP: open the app in a plain popup.
  function fallbackPopout() {
    try {
      window.open(location.href, 'aizen-popout', 'width=460,height=680');
    } catch {
      if (els.popout) {
        els.popout.disabled = true;
        els.popout.title = 'Pop-out needs a Chromium browser (Chrome/Edge 116+).';
      }
    }
  }

  async function popOut() {
    if (popoutBusy) return; // a window is mid-open — ignore the extra click
    if (pipWindow) {
      // Already popped out → this click means "Return": close it; pagehide restores.
      try { pipWindow.close(); } catch {}
      return;
    }
    if (!('documentPictureInPicture' in window) || !window.documentPictureInPicture) {
      fallbackPopout();
      return;
    }
    popoutBusy = true;
    let win;
    try {
      win = await window.documentPictureInPicture.requestWindow({ width: 460, height: 680 });
    } catch {
      popoutBusy = false; // user dismissed / blocked — nothing moved, button unchanged
      return;
    }
    pipWindow = win;
    copyStylesInto(win);
    // Match the pop-out to the opener's theme (it's a separate document, so it
    // would otherwise render with the default light theme regardless of choice).
    if (win.document && win.document.documentElement) {
      win.document.documentElement.setAttribute('data-theme', currentTheme());
    }
    if (win.document && win.document.body) {
      win.document.body.classList.add('pip-body');
      movePanelsInto(win.document.body);
    }
    win.addEventListener('pagehide', onPipClosed);
    setPopoutLabel(true);
    popoutBusy = false;
  }

  if (els.popout) els.popout.addEventListener('click', popOut);

  // ---- account: sign in / out · identity + tier · quota usage --------------
  // Layered around the live pipeline: the app boots and runs anonymously exactly
  // as before; this only lights up the account widget. All element access is
  // guarded so a missing widget (or no `fetch`) never breaks the core flow.
  const PROVIDER_LABELS = {
    stub: 'Continue with a demo account',
    google: 'Continue with Google',
    microsoft: 'Continue with Microsoft',
  };
  // Current account view (null = anonymous). Drives the save button + quota meter.
  let account = null;
  // The full last /api/session response (auth state + provider_status + plans +
  // quota). The Providers/Settings popups render from this.
  let sessionInfo = null;

  function show(el, visible) {
    if (el) el.hidden = !visible;
  }

  // Two letters for the avatar, from the display name or email.
  function initials(nameOrEmail) {
    const s = (nameOrEmail || '').trim();
    if (!s) return 'AZ';
    const parts = s.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function setAcctMsg(text, kind) {
    if (!els.acctMsg) return;
    if (!text) {
      show(els.acctMsg, false);
      return;
    }
    els.acctMsg.textContent = text;
    els.acctMsg.className = 'acct-msg' + (kind ? ' ' + kind : '');
    show(els.acctMsg, true);
  }

  // Build the sign-in menu (one button per offered provider). Clicking a provider
  // navigates to its server login route, which begins the OAuth (or stub) flow.
  function renderSigninMenu(providers) {
    if (!els.acctMenu) return;
    els.acctMenu.innerHTML = '';
    (providers || ['stub']).forEach((p) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.type = 'button';
      btn.dataset.provider = p;
      btn.textContent = PROVIDER_LABELS[p] || ('Sign in with ' + p);
      btn.addEventListener('click', () => {
        location.href = '/auth/' + encodeURIComponent(p) + '/login';
      });
      els.acctMenu.appendChild(btn);
    });
  }

  // Reflect a quota status ({used, limit, exceeded, tier}) on the meter.
  function renderQuota(q) {
    if (!q) return;
    const limitText = q.limit === null || q.limit === undefined ? '∞' : String(q.limit);
    if (els.quotaText) els.quotaText.textContent = q.used + ' of ' + limitText;
    if (els.quotaFill) {
      const pct = q.limit ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
      els.quotaFill.style.width = pct + '%';
    }
    if (els.quota) els.quota.classList.toggle('over', !!q.exceeded);
    show(els.quotaOver, !!q.exceeded);
  }

  function renderAccount(state) {
    account = state && state.authenticated ? state : null;
    const signedIn = !!account;
    show(els.acctSignin, !signedIn);
    show(els.acctUser, signedIn);
    if (!signedIn) {
      renderSigninMenu((state && state.providers) || ['stub']);
      return;
    }
    const acc = state.account || {};
    const id = state.identity || {};
    const name = id.display_name || acc.display_name || id.email || 'Account';
    const tier = (acc.tier || 'free').toString();
    if (els.acctName) els.acctName.textContent = name;
    if (els.acctFullname) els.acctFullname.textContent = name;
    if (els.acctEmail) els.acctEmail.textContent = id.email || '';
    if (els.acctAvatar) els.acctAvatar.textContent = initials(name || id.email);
    if (els.acctTier) {
      els.acctTier.textContent = tier.toUpperCase();
      els.acctTier.className = 'tier-chip tier-' + tier;
    }
    renderQuota(state.quota);
    setAcctMsg('');
  }

  function bootAccount() {
    if (typeof fetch !== 'function') return; // older/sandboxed runtime — stay anonymous
    fetch('/api/session', { headers: { accept: 'application/json' } })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          sessionInfo = data;
          renderAccount(data);
          // Keep an open Settings/Providers popup fresh after re-fetch (e.g. sign in/out).
          if (openModalKind) renderOpenModal();
          // F3 Phase B: reload the account's stored sources into the library (once).
          bootStoredSources();
        }
      })
      .catch(() => {
        /* network/boot error — leave the widget hidden, core flow unaffected */
      });
  }

  // Gather the current session's transcript as owned artifacts to persist with the
  // saved resource (each final line → one transcript_segment artifact).
  function collectArtifacts() {
    const out = [];
    for (const [id, line] of model.transcript) {
      if (line.is_final && line.text) {
        out.push({ id: String(id), kind: 'transcript_segment', payload: { text: line.text, who: line.who } });
      }
    }
    // Persist the live intelligence too (the server already accepts these kinds), so a
    // reopened session keeps its concepts, insights, recap, and graph — not just text.
    for (const c of model.cards.values()) out.push({ id: c.id, kind: 'concept_card', payload: c });
    for (const i of model.insights.values()) out.push({ id: i.id, kind: 'insight_item', payload: i });
    for (const n of model.graph.nodes.values()) out.push({ id: n.id, kind: 'kg_node', payload: n });
    for (const e of model.graph.edges.values()) out.push({ id: e.id, kind: 'kg_edge', payload: e });
    if (model.summary && model.summary.text) {
      out.push({ id: 'summary_' + (currentSessionId || 'x'), kind: 'session_summary', payload: model.summary });
    }
    return out;
  }

  function sessionTitle() {
    for (const line of model.transcript.values()) {
      if (line.is_final && line.text) return line.text.slice(0, 60);
    }
    return 'Live session';
  }

  function saveSession() {
    if (!account) return;
    if (typeof fetch !== 'function') return;
    if (!currentSessionId) {
      setAcctMsg('Connect a session first, then save.', 'error');
      return;
    }
    if (els.saveSessionBtn) els.saveSessionBtn.disabled = true;
    setAcctMsg('Saving…');
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: currentSessionId,
        title: sessionTitle(),
        artifacts: collectArtifacts(),
      }),
    })
      .then((r) => r.json().then((body) => ({ status: r.status, body })))
      .then(({ status, body }) => {
        if (status === 201) {
          renderQuota(body.quota);
          setAcctMsg('Saved. ' + (body.quota ? body.quota.used + ' of ' + (body.quota.limit ?? '∞') + ' used.' : ''), 'ok');
        } else if (status === 409) {
          // Over the tier cap — show the typed, user-legible quota error + state.
          if (els.quota) els.quota.classList.add('over');
          show(els.quotaOver, true);
          if (els.quotaText && body) els.quotaText.textContent = body.used + ' of ' + body.limit;
          setAcctMsg((body && body.message ? body.message + ' ' : '') + (body && body.remedy ? body.remedy : ''), 'error');
        } else {
          setAcctMsg((body && (body.message || body.error)) || 'Could not save the session.', 'error');
        }
      })
      .catch(() => setAcctMsg('Could not save the session — please try again.', 'error'))
      .finally(() => {
        if (els.saveSessionBtn) els.saveSessionBtn.disabled = false;
      });
  }

  function signOut() {
    if (typeof fetch !== 'function') return;
    storedSourcesLoaded = false; // a future sign-in reloads that account's stored sources
    fetch('/auth/logout', { method: 'POST' })
      .then(() => {
        show(els.acctPanel, false);
        bootAccount(); // re-fetch → renders the anonymous (sign-in) state
      })
      .catch(() => {
        /* leave UI as-is on failure */
      });
  }

  // Toggle helpers for the two popovers (sign-in menu / account panel).
  function togglePanel(panelEl, btnEl) {
    if (!panelEl) return;
    const open = panelEl.hidden;
    show(panelEl, open);
    if (btnEl) btnEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  if (els.signinBtn) els.signinBtn.addEventListener('click', () => togglePanel(els.acctMenu, els.signinBtn));
  if (els.acctChip) els.acctChip.addEventListener('click', () => togglePanel(els.acctPanel, els.acctChip));
  if (els.saveSessionBtn) els.saveSessionBtn.addEventListener('click', saveSession);
  if (els.signoutBtn) els.signoutBtn.addEventListener('click', signOut);

  // Close the open popover when clicking outside the account widget.
  document.addEventListener('click', (e) => {
    const acct = document.getElementById('account');
    if (acct && e.target && e.target.closest && e.target.closest('#account')) return;
    show(els.acctMenu, false);
    show(els.acctPanel, false);
    if (els.signinBtn) els.signinBtn.setAttribute('aria-expanded', 'false');
    if (els.acctChip) els.acctChip.setAttribute('aria-expanded', 'false');
  });

  // ---- popups: Providers/Settings + exclusive "focus" views ------------------
  // The sidebar tabs open the shared modal instead of scrolling. Two kinds:
  //   • info popups   — Providers (active STT/LLM/search/auth + quota-limits table)
  //                     and Settings (the signed-in account / sign-in options).
  //   • focus popups  — Transcript / Explanation / Activity / Sources: show ONLY
  //                     that one workspace section. For the three live sections we
  //                     RELOCATE the real card into the modal body (so all live
  //                     rendering keeps targeting the same elements) and move it
  //                     back on close; Sources has no card, so it's built fresh.
  let openModalKind = null; // null | 'providers' | 'settings' | 'transcript' | 'explanation' | 'activity' | 'sources' | 'history'

  // Focus popups that show a live section by relocating its card into the modal.
  const FOCUS_SECTIONS = {
    transcript: { id: 'card-transcript', title: 'Transcript' },
    explanation: { id: 'card-explanation', title: 'Explanation' },
    activity: { id: 'card-stats', title: 'Activity' },
    concepts: { id: 'card-concepts', title: 'Concepts' },
    insights: { id: 'card-insights', title: 'Insights' },
    summary: { id: 'card-summary', title: 'Recap' },
    graph: { id: 'card-graph', title: 'Knowledge graph' },
  };
  let focusedNode = null; // the live card currently relocated into the modal
  let focusHome = null; // { parent, next } to put it back exactly where it was

  function setModalFocus(on) {
    if (els.modalOverlay) els.modalOverlay.classList.toggle('modal-focus', !!on);
  }

  // Move a live section into the modal body, remembering where it came from. The
  // section keeps its identity (same element ids), so renderTranscript /
  // renderExplanation / updateStats keep updating it in its new home.
  function moveFocusInto(sectionId, dest) {
    const node = document.getElementById(sectionId);
    if (!node || !dest) return;
    focusedNode = node;
    focusHome = { parent: node.parentNode, next: node.nextSibling };
    dest.appendChild(node);
  }

  // Put a relocated section back in the dashboard. MUST run before the modal body
  // is wiped (clearing innerHTML would otherwise orphan the live card).
  function restoreFocusNode() {
    if (focusedNode && focusHome && focusHome.parent) {
      focusHome.parent.insertBefore(focusedNode, focusHome.next || null);
    }
    focusedNode = null;
    focusHome = null;
  }

  // Re-render an open data-derived focus popup (Sources) when its data changes.
  // The live-card focus views (Transcript/Explanation/Activity) update themselves.
  function refreshFocusData() {
    if (openModalKind === 'sources') renderOpenModal();
  }

  // Small DOM builder: mk('div', 'cls', 'text').
  function mk(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function tierName(t) {
    const s = String(t || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
  }
  function fmtCap(n) {
    return n === null || n === undefined ? 'Custom' : String(n);
  }
  function fmtRetention(days) {
    if (days === null || days === undefined) return 'Custom';
    if (days <= 14) return days + (days === 1 ? ' day' : ' days');
    const months = Math.round(days / 30);
    if (months % 12 === 0) {
      const y = months / 12;
      return y + (y === 1 ? ' year' : ' years');
    }
    return months + ' months';
  }
  function fmtModels(tierCap) {
    return tierCap === 'haiku' ? 'Haiku only' : 'Sonnet + Opus';
  }
  function authLabel(a) {
    if (a === 'google+microsoft') return 'Google or Microsoft';
    if (a === 'google') return 'Google';
    if (a === 'microsoft') return 'Microsoft';
    return 'a demo account';
  }

  // The active STT/LLM/search/auth status: prefer the server's /api/session
  // snapshot, fall back to the live WS status frame.
  function providerStatus() {
    return (sessionInfo && sessionInfo.provider_status) || wsProviderStatus || {};
  }

  // The on/off switch shown on the Providers "Web search" row when a Tavily key is
  // configured. Reflects + persists the user's web-search preference; toggling it
  // re-renders the Providers body so the row's wording updates.
  function buildWebSearchSwitch() {
    const sw = mk('span', 'switch prov-switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch-input';
    input.checked = webSearchEnabled();
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', 'Use web search (Tavily) for answers');
    input.addEventListener('change', () => setWebSearch(input.checked, true));
    sw.appendChild(input);
    sw.appendChild(mk('span', 'switch-track'));
    return sw;
  }

  function buildProvidersBody() {
    const ps = providerStatus();
    const body = mk('div', 'modal-content');

    // Web search is special: it's the one provider the user can switch on/off here
    // (when a Tavily key is configured). `webKeyed` = a key is present; the effective
    // state also folds in the user's "Web search" toggle. With no key it's just off.
    const webKeyed = ps.search === 'tavily';
    const webOn = webKeyed && webSearchEnabled();

    const defs = [
      { key: 'stt', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/></svg>', name: 'Speech-to-text', on: ps.stt === 'deepgram',
        onText: 'Deepgram — live transcription of your mic & computer audio.',
        offText: 'Stub — a canned demo clip drives the transcript.', onBadge: 'Live', offBadge: 'Demo', offCls: 'demo' },
      { key: 'llm', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 4 1.6 3.9L17.5 9.5l-3.9 1.6L12 15l-1.6-3.9L6.5 9.5l3.9-1.6z"/><path d="M19 14l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/></svg>', name: 'Explanations', on: ps.llm === 'anthropic',
        onText: 'Anthropic Claude — plain-language explanations & answers.',
        offText: 'Stub — canned demo replies (add ANTHROPIC_API_KEY).', onBadge: 'Live', offBadge: 'Demo', offCls: 'demo' },
      { key: 'search', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>', name: 'Web search', on: webOn,
        onText: 'Tavily — answers grounded in cited web sources.',
        offText: webKeyed
          ? 'Turned off — answers rely on the model and your own sources, with no web lookup.'
          : 'Off — answers rely on the model alone (add TAVILY_API_KEY).', onBadge: 'On', offBadge: 'Off', offCls: '' },
      { key: 'auth', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>', name: 'Sign-in', on: !!(ps.auth && ps.auth !== 'stub'),
        onText: 'OAuth — sign in with ' + authLabel(ps.auth) + '.',
        offText: 'Demo accounts — no OAuth keys set (stub provider).', onBadge: 'OAuth', offBadge: 'Demo', offCls: 'demo' },
    ];

    const list = mk('div', 'prov-list');
    defs.forEach((d) => {
      const row = mk('div', 'prov-row');
      const provIco = mk('span', 'prov-ico');
      provIco.innerHTML = d.icon;
      row.appendChild(provIco);
      const main = mk('div', 'prov-main');
      main.appendChild(mk('div', 'prov-name', d.name));
      main.appendChild(mk('p', 'prov-desc', d.on ? d.onText : d.offText));
      row.appendChild(main);
      // The Web-search row is interactive when a key is configured: a switch lets the
      // user turn lookups off for the session (Tavily isn't called; answers fall back
      // to the model + their own sources). Every other row stays a status badge.
      if (d.key === 'search' && webKeyed) {
        row.appendChild(buildWebSearchSwitch());
      } else {
        const badge = mk('span', 'prov-badge' + (d.on ? ' on' : d.offCls ? ' ' + d.offCls : ''), d.on ? d.onBadge : d.offBadge);
        row.appendChild(badge);
      }
      list.appendChild(row);
    });
    body.appendChild(list);

    // Plan / quota-limits table.
    const plans = (sessionInfo && sessionInfo.plans) || [];
    if (plans.length) {
      body.appendChild(mk('p', 'modal-section-label', 'Plan quota limits'));
      const table = mk('table', 'plan-table');
      const thead = mk('thead');
      const htr = mk('tr');
      ['Plan', 'Saved sessions', 'Retention', 'AI models'].forEach((h) => htr.appendChild(mk('th', null, h)));
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = mk('tbody');
      const currentTier = sessionInfo && sessionInfo.account && sessionInfo.account.tier;
      plans.forEach((p) => {
        const tr = mk('tr', p.tier === currentTier ? 'current' : null);
        const nameTd = mk('td', null, tierName(p.tier));
        if (p.tier === currentTier) nameTd.appendChild(mk('span', 'plan-current-tag', 'You'));
        tr.appendChild(nameTd);
        tr.appendChild(mk('td', 'plan-cap', fmtCap(p.max_resources)));
        tr.appendChild(mk('td', null, fmtRetention(p.retention_window_days)));
        tr.appendChild(mk('td', null, fmtModels(p.model_tier_cap)));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      body.appendChild(table);
    }
    return body;
  }

  // A labelled slider in Settings (Performance section) for "Fast answers": answer
  // as fast as possible. Off by default; flipping it on makes every explain/ask run
  // the web search at sub-second 'fast' depth with fewer sources + a tighter timeout
  // (PERFORMANCE_RESEARCH.md §4). A local client preference (rides each request),
  // shown for anonymous and signed-in users alike.
  function buildFastAnswersToggleSection() {
    const sec = mk('div', 'set-feature');
    sec.appendChild(mk('p', 'modal-section-label', 'Performance'));

    const row = mk('label', 'switch-row');
    const main = mk('div', 'switch-main');
    main.appendChild(mk('div', 'switch-title', 'Fast answers'));
    main.appendChild(
      mk('p', 'switch-desc',
        'Answer as fast as possible. Web lookups run at a sub-second depth, pull ' +
        'fewer sources, and time out sooner — trading a little search breadth for ' +
        'speed. Streaming is always on; this tightens what happens behind it.'),
    );
    row.appendChild(main);

    const sw = mk('span', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch-input';
    input.checked = fastAnswersEnabled();
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', 'Answer as fast as possible');
    input.addEventListener('change', () => setFastAnswers(input.checked, true));
    sw.appendChild(input);
    sw.appendChild(mk('span', 'switch-track'));
    row.appendChild(sw);

    sec.appendChild(row);
    return sec;
  }

  // A labelled slider in Settings that flips the Obsidian integration on/off.
  // Off by default; turning it on unhides the Obsidian connect card in the
  // Sources popup. Shown for both anonymous and signed-in users (it's a local
  // client preference, not an account feature).
  function buildObsidianToggleSection() {
    const sec = mk('div', 'set-feature');
    sec.appendChild(mk('p', 'modal-section-label', 'Integrations'));

    const row = mk('label', 'switch-row');
    const main = mk('div', 'switch-main');
    main.appendChild(mk('div', 'switch-title', 'Obsidian vault'));
    main.appendChild(
      mk('p', 'switch-desc',
        'Connect a local Obsidian vault so its notes ground answers. Off by default — ' +
        'turning this on reveals the connector under Sources.'),
    );
    row.appendChild(main);

    const sw = mk('span', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch-input';
    input.checked = obsidianEnabled();
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', 'Enable Obsidian vault integration');
    input.addEventListener('change', () => setObsidianEnabled(input.checked, true));
    sw.appendChild(input);
    sw.appendChild(mk('span', 'switch-track'));
    row.appendChild(sw);

    sec.appendChild(row);
    return sec;
  }

  function buildSettingsBody() {
    const body = mk('div', 'modal-content');

    if (!account) {
      const wrap = mk('div', 'set-anon');
      wrap.appendChild(mk('p', null, "You're browsing anonymously. Sign in to save sessions and get a tier-gated quota."));
      const providers = (sessionInfo && sessionInfo.providers) || ['stub'];
      providers.forEach((p) => {
        const btn = mk('button', 'btn btn-primary', PROVIDER_LABELS[p] || ('Sign in with ' + p));
        btn.type = 'button';
        btn.addEventListener('click', () => {
          location.href = '/auth/' + encodeURIComponent(p) + '/login';
        });
        wrap.appendChild(btn);
      });
      body.appendChild(wrap);
      body.appendChild(buildFastAnswersToggleSection());
      body.appendChild(buildObsidianToggleSection());
      return body;
    }

    const acc = (sessionInfo && sessionInfo.account) || {};
    const id = (sessionInfo && sessionInfo.identity) || {};
    const q = (sessionInfo && sessionInfo.quota) || {};
    const name = id.display_name || acc.display_name || id.email || 'Account';

    const idRow = mk('div', 'set-id');
    idRow.appendChild(mk('span', 'set-avatar', initials(name || id.email)));
    const idMain = mk('div', 'set-id-main');
    idMain.appendChild(mk('div', 'set-id-name', name));
    idMain.appendChild(mk('div', 'set-id-sub', (id.email || '') + (id.provider ? '  ·  via ' + id.provider : '')));
    idRow.appendChild(idMain);
    body.appendChild(idRow);

    const grid = mk('div', 'set-grid');
    const cell = (label, value) => {
      const c = mk('div', 'set-cell');
      c.appendChild(mk('div', 'set-cell-label', label));
      c.appendChild(mk('div', 'set-cell-value', value));
      return c;
    };
    const limitText = q.limit === null || q.limit === undefined ? '∞' : String(q.limit);
    grid.appendChild(cell('Plan', tierName(acc.tier)));
    grid.appendChild(cell('Saved sessions', (q.used != null ? q.used : 0) + ' of ' + limitText));
    grid.appendChild(cell('Retention', fmtRetention(q.retention_window_days)));
    grid.appendChild(cell('Sign-in', id.provider ? tierName(id.provider) : '—'));
    body.appendChild(grid);

    if (q.exceeded) {
      body.appendChild(mk('p', 'quota-over', "You've reached your plan's saved-session limit. Delete a saved session or upgrade for more."));
    }

    const actions = mk('div', 'set-actions');
    const saveBtn = mk('button', 'btn btn-primary', 'Save this session');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => {
      saveSession();
    });
    const outBtn = mk('button', 'btn btn-secondary', 'Sign out');
    outBtn.type = 'button';
    outBtn.addEventListener('click', () => {
      closeModal();
      signOut();
    });
    actions.appendChild(saveBtn);
    actions.appendChild(outBtn);
    body.appendChild(actions);

    body.appendChild(buildFastAnswersToggleSection());
    body.appendChild(buildObsidianToggleSection());
    return body;
  }

  // Every web source cited this session, gathered from explanation answers and
  // follow-up answers, de-duplicated by URL (newest sentence/question kept as the
  // "where it came from" context). Drives the Sources focus popup.
  function collectAllSources() {
    const seen = new Set();
    const out = [];
    const add = (s, ctx) => {
      if (!s || !s.url || seen.has(s.url)) return;
      seen.add(s.url);
      out.push({ url: s.url, title: s.title || s.url, context: ctx });
    };
    for (const st of model.explanations.values()) {
      if (st.state === 'done' && st.ex && st.ex.sources) {
        st.ex.sources.forEach((s) => add(s, st.ex.sentence || ''));
      }
    }
    for (const fu of model.followups) {
      if (fu.answer && fu.answer.sources) fu.answer.sources.forEach((s) => add(s, fu.question || ''));
    }
    return out;
  }

  // Build the "Your sources" section: an add form (text + optional title/URL) and
  // a removable row per source the user has provided. Re-rendered on add/remove.
  function buildUserSourcesSection() {
    const wrap = mk('div', 'usrc-section');
    const pasted = pasteSources();
    const count = pasted.length;
    wrap.appendChild(
      mk('p', 'modal-section-label', 'Your sources' + (count ? ' (' + count + ')' : '')),
    );
    wrap.appendChild(
      mk('p', 'sources-hint',
        'Hand the AI a note, brief, or a URL with a comment. Answers are grounded in ' +
        'these — even with web search off.'),
    );

    const form = mk('div', 'usrc-form');
    const titleInput = document.createElement('input');
    titleInput.className = 'usrc-input';
    titleInput.type = 'text';
    titleInput.placeholder = 'Title (optional)';
    const urlInput = document.createElement('input');
    urlInput.className = 'usrc-input';
    urlInput.type = 'text';
    urlInput.placeholder = 'URL (optional)';
    const textInput = document.createElement('textarea');
    textInput.className = 'usrc-textarea';
    textInput.placeholder = 'Paste a note, brief, or context the AI should use…';
    const addBtn = mk('button', 'btn btn-primary usrc-add', 'Add source');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => {
      addUserSource({ title: titleInput.value, url: urlInput.value, text: textInput.value });
    });
    form.appendChild(titleInput);
    form.appendChild(urlInput);
    form.appendChild(textInput);
    form.appendChild(addBtn);
    wrap.appendChild(form);

    if (count) {
      const ulist = mk('div', 'usrc-list');
      pasted.forEach((u) => {
        const row = mk('div', 'usrc-item');
        const main = mk('div', 'usrc-main');
        if (u.title) main.appendChild(mk('div', 'usrc-title', u.title));
        if (u.url) {
          const a = document.createElement('a');
          a.className = 'usrc-url';
          a.href = u.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = u.url;
          main.appendChild(a);
        }
        main.appendChild(mk('p', 'usrc-text', u.text));
        appendSaveControls(main, u); // F3 Phase B — Save to account / Saved badge
        row.appendChild(main);
        const rm = mk('button', 'usrc-remove', '✕');
        rm.type = 'button';
        rm.title = 'Remove source';
        rm.addEventListener('click', () => removeUserSource(u.id));
        row.appendChild(rm);
        ulist.appendChild(row);
      });
      wrap.appendChild(ulist);
    }
    return wrap;
  }

  // F3 — "Local files": a file picker + drop zone, then a row per added file
  // (name, size, parsing→✓/error, remove ✕). Built fresh on each Sources render.
  function buildFilesSection() {
    const wrap = mk('div', 'usrc-section');
    const entries = model.fileEntries;
    wrap.appendChild(
      mk('p', 'modal-section-label', 'Local files' + (entries.length ? ' (' + entries.length + ')' : '')),
    );
    wrap.appendChild(
      mk('p', 'sources-hint',
        'Add your own files (.md, .txt, .csv, .json, code, or PDF). The AI grounds answers in the ' +
        'parts relevant to each question — files stay in your browser.'),
    );
    const storage = storageLine(); // F3 Phase B — byte-quota meter when signed in
    if (storage) wrap.appendChild(storage);

    const drop = mk('div', 'usrc-drop');
    drop.appendChild(mk('span', 'usrc-drop-text', 'Drag files here, or'));
    const pick = mk('button', 'btn btn-secondary usrc-file-btn', 'Choose files');
    pick.type = 'button';
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.className = 'usrc-file-input';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = ''; // allow re-adding the same file later
    });
    pick.addEventListener('click', () => input.click());
    drop.appendChild(pick);
    drop.appendChild(input);
    // Drag-and-drop (guarded; the headless harness has no DataTransfer).
    drop.addEventListener('dragover', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      drop.classList.add('drag');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      drop.classList.remove('drag');
      const dt = e && e.dataTransfer;
      if (dt && dt.files) addFiles(dt.files);
    });
    wrap.appendChild(drop);

    if (entries.length) {
      const list = mk('div', 'usrc-list');
      entries.forEach((entry) => list.appendChild(fileRow(entry)));
      wrap.appendChild(list);
    }
    return wrap;
  }

  function fileRow(entry) {
    const row = mk('div', 'usrc-item usrc-file-item');
    const main = mk('div', 'usrc-main');
    const head = mk('div', 'usrc-file-head');
    head.appendChild(mk('span', 'usrc-title', entry.name));
    if (entry.size) head.appendChild(mk('span', 'usrc-file-size', formatBytes(entry.size)));
    main.appendChild(head);
    const status = mk('div', 'usrc-file-status');
    if (entry.status === 'parsing') {
      status.classList.add('muted');
      status.textContent = 'Parsing…';
    } else if (entry.status === 'error') {
      status.classList.add('usrc-file-error');
      status.textContent = entry.error || 'Could not read this file.';
    } else {
      status.classList.add('usrc-file-ok');
      status.textContent =
        '✓ Added' + (entry.chunks ? ' · ' + entry.chunks + (entry.chunks === 1 ? ' chunk' : ' chunks') : '');
    }
    main.appendChild(status);
    // F3 Phase B — once parsed, offer Save to account / show the Saved badge.
    if (entry.status === 'done' && entry.docId) {
      const lib = srcLib();
      const doc = lib ? lib.getDoc(entry.docId) : null;
      if (doc) appendSaveControls(main, doc);
    }
    row.appendChild(main);
    const rm = mk('button', 'usrc-remove', '✕');
    rm.type = 'button';
    rm.title = 'Remove file';
    rm.addEventListener('click', () => removeFileEntry(entry));
    row.appendChild(rm);
    return row;
  }

  function formatBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // F4 — "Obsidian vault": a Connect card with a small state machine
  // (idle → connecting → connected) plus Re-sync / Disconnect, and a folder-upload
  // fallback for browsers without the File System Access API.
  function buildObsidianSection() {
    const wrap = mk('div', 'usrc-section obs-section');
    wrap.appendChild(mk('p', 'modal-section-label', 'Obsidian vault'));
    const o = model.obsidian;
    const obs = obsLib();
    // If obsidian.js never loaded (window.AizenObsidian is undefined), no provider
    // can be built — say so plainly instead of the misleading "can't pick a folder".
    if (!obs) {
      const card = mk('div', 'obs-card');
      card.appendChild(
        mk('p', 'usrc-file-error',
          'Obsidian support didn’t load (/obsidian.js). Hard-refresh the page (Ctrl/Cmd+Shift+R); ' +
          'if it persists, your server is out of date — restart it (stop it and run “pnpm start” again).'),
      );
      wrap.appendChild(card);
      return wrap;
    }
    const canPick = !!(obs.supportsDirectoryPicker && obs.supportsDirectoryPicker());
    const card = mk('div', 'obs-card');

    if (o.status === 'connected') {
      card.appendChild(
        mk('div', 'obs-state obs-connected',
          'Connected · ' + (o.vaultName || 'vault') + ' · ' + o.notes + (o.notes === 1 ? ' note' : ' notes') +
          (o.chunks ? ' · ' + o.chunks + (o.chunks === 1 ? ' chunk' : ' chunks') : '')),
      );
      const actions = mk('div', 'obs-actions');
      const resync = mk('button', 'btn btn-secondary', o.busy ? 'Re-syncing…' : 'Re-sync');
      resync.type = 'button';
      resync.disabled = !!o.busy;
      resync.addEventListener('click', resyncObsidian);
      const disc = mk('button', 'btn btn-secondary', 'Disconnect');
      disc.type = 'button';
      disc.addEventListener('click', disconnectObsidian);
      actions.appendChild(resync);
      actions.appendChild(disc);
      card.appendChild(actions);
    } else if (o.status === 'connecting') {
      card.appendChild(mk('div', 'obs-state', 'Connecting…' + (o.notes ? ' (' + o.notes + ' notes read)' : '')));
    } else {
      card.appendChild(
        mk('p', 'sources-hint',
          'Connect your local Obsidian vault so its notes ground answers. Read-only — Aizen never ' +
          'writes to your vault, and notes stay in your browser.'),
      );
      const hasPicker = canPick || (o.restorable && restoredObsidianHandle);
      if (!hasPicker) {
        // No File System Access API → the folder-upload is the only path; say why.
        card.appendChild(
          mk('p', 'obs-why', 'This browser can’t pick a folder directly — use “Upload vault folder” below.'),
        );
      }
      // Both connection options are real, MATCHED `.btn` pills in one row. The folder
      // upload is a hidden <input webkitdirectory> fired by a styled button (so it
      // matches the picker button instead of rendering as a raw "No file chosen" field).
      const actions = mk('div', 'obs-actions');

      const up = document.createElement('input');
      up.type = 'file';
      up.className = 'obs-upload';
      up.setAttribute('webkitdirectory', '');
      up.setAttribute('directory', '');
      up.multiple = true;
      up.style.display = 'none';
      up.addEventListener('change', () => {
        if (up.files && up.files.length) connectObsidian({ files: up.files });
      });

      // Primary action: reconnect a persisted handle, else the directory picker.
      if (o.restorable && restoredObsidianHandle) {
        const re = mk('button', 'btn btn-primary', 'Reconnect Obsidian vault');
        re.type = 'button';
        re.addEventListener('click', reconnectObsidian);
        actions.appendChild(re);
      } else if (canPick) {
        const btn = mk('button', 'btn btn-primary', 'Connect Obsidian vault');
        btn.type = 'button';
        btn.addEventListener('click', () => connectObsidian({}));
        actions.appendChild(btn);
      }
      // Folder-upload button — secondary alongside a picker, else the primary CTA.
      const upBtn = mk('button', 'btn ' + (hasPicker ? 'btn-secondary' : 'btn-primary') + ' obs-upload-btn', 'Upload vault folder');
      upBtn.type = 'button';
      upBtn.addEventListener('click', () => up.click());
      actions.appendChild(upBtn);
      actions.appendChild(up);
      card.appendChild(actions);
    }
    if (o.error) card.appendChild(mk('p', 'usrc-file-error obs-error', o.error));
    wrap.appendChild(card);
    return wrap;
  }

  function buildSourcesBody() {
    const body = mk('div', 'modal-content');

    // If the S0 helper scripts didn't load (window.AizenSources/AizenObsidian
    // undefined — usually a server started before these routes existed), retrieval +
    // Obsidian are degraded. Surface one clear, actionable banner up top. Only flag
    // the missing Obsidian helper when the integration is actually enabled.
    const obsOn = obsidianEnabled();
    if (!srcLib() || (obsOn && !obsLib())) {
      body.appendChild(
        mk('p', 'usrc-file-error',
          'Some source features didn’t load (/sources.js, /obsidian.js). Hard-refresh ' +
          '(Ctrl/Cmd+Shift+R); if it persists, restart your server — stop it and run “pnpm start” again.'),
      );
    }

    // "Your sources" (pasted context), then local files (F3), then Obsidian (F4) —
    // all pour into the one S0 library; the cited-web list sits below. Obsidian is
    // an opt-in integration, so its connector only appears once enabled in Settings.
    body.appendChild(buildUserSourcesSection());
    body.appendChild(buildFilesSection());
    if (obsOn) body.appendChild(buildObsidianSection());

    // "Cited sources" — the web pages grounded answers have cited this session.
    const sources = collectAllSources();
    if (!sources.length) {
      body.appendChild(
        mk('p', 'sources-empty',
          'No web sources cited yet. Ask a question during a live session — grounded ' +
          'answers list the web pages they cite, and they all collect here.'),
      );
      return body;
    }
    body.appendChild(
      mk('p', 'modal-section-label', sources.length + (sources.length === 1 ? ' cited source' : ' cited sources')),
    );
    const list = mk('div', 'src-list');
    sources.forEach((s) => {
      const row = mk('div', 'src-item');
      const a = document.createElement('a');
      a.className = 'src-link';
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = s.title;
      row.appendChild(a);
      try {
        row.appendChild(mk('span', 'src-host', new URL(s.url).hostname.replace(/^www\./, '')));
      } catch (e) {
        /* non-absolute/odd URL or no URL ctor — just omit the host chip */
      }
      if (s.context) row.appendChild(mk('p', 'src-ctx', s.context));
      list.appendChild(row);
    });
    body.appendChild(list);
    return body;
  }

  // ---- F1: Saved-session history (the "Saved sessions" popup) --------------
  // A signed-in user browses the sessions they've saved, opens one to read its
  // transcript back (read-only — separate, inert from the live view), or deletes
  // one to free a quota slot. This is the read/browse half of the account system;
  // the save half already ships. Anonymous users see a sign-in prompt, never
  // another account's data (the backend is account-scoped, so it's enforced
  // server-side regardless).

  // A short relative "when" from a microsecond epoch (created_at_us).
  function relTime(us) {
    if (!us) return '';
    const diffMs = Math.max(0, Date.now() - us / 1000);
    const sec = Math.round(diffMs / 1000);
    if (sec < 60) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return min + (min === 1 ? ' minute ago' : ' minutes ago');
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
    const day = Math.round(hr / 24);
    if (day < 30) return day + (day === 1 ? ' day ago' : ' days ago');
    const mon = Math.round(day / 30);
    if (mon < 12) return mon + (mon === 1 ? ' month ago' : ' months ago');
    const yr = Math.round(mon / 12);
    return yr + (yr === 1 ? ' year ago' : ' years ago');
  }

  // Build the History popup body synchronously (like buildSourcesBody), then fill
  // it from GET /api/sessions. Anonymous → a sign-in prompt instead.
  function buildHistoryBody() {
    const body = mk('div', 'modal-content');
    if (!account) {
      const wrap = mk('div', 'set-anon');
      wrap.appendChild(mk('p', null, 'Sign in to save sessions and revisit them here.'));
      const providers = (sessionInfo && sessionInfo.providers) || ['stub'];
      providers.forEach((p) => {
        const btn = mk('button', 'btn btn-primary', PROVIDER_LABELS[p] || ('Sign in with ' + p));
        btn.type = 'button';
        btn.addEventListener('click', () => {
          location.href = '/auth/' + encodeURIComponent(p) + '/login';
        });
        wrap.appendChild(btn);
      });
      body.appendChild(wrap);
      return body;
    }
    fillHistory(body);
    return body;
  }

  // (Re)load the saved-session list into `body`. Guarded against races: a late
  // response is dropped if the user has switched away from the History popup.
  function fillHistory(body) {
    body.innerHTML = '';
    body.appendChild(mk('p', 'sources-empty', 'Loading your saved sessions…'));
    if (typeof fetch !== 'function') return;
    fetch('/api/sessions', { headers: { accept: 'application/json' } })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (openModalKind !== 'history') return; // user switched popups
        renderHistoryList(body, data);
      })
      .catch(() => {
        if (openModalKind !== 'history') return;
        body.innerHTML = '';
        body.appendChild(mk('p', 'sources-empty', 'Could not load your saved sessions.'));
      });
  }

  function renderHistoryList(body, data) {
    body.innerHTML = '';
    if (data && data.quota) renderQuota(data.quota); // keep the account meter in sync
    const sessions = ((data && data.sessions) || []).slice().sort(
      (a, b) => (b.created_at_us || 0) - (a.created_at_us || 0), // newest-first
    );
    if (!sessions.length) {
      body.appendChild(mk('p', 'sources-empty', 'No saved sessions yet — save one from your account menu.'));
      return;
    }
    body.appendChild(
      mk('p', 'modal-section-label', sessions.length + (sessions.length === 1 ? ' saved session' : ' saved sessions')),
    );
    const list = mk('div', 'hist-list');
    sessions.forEach((s) => list.appendChild(historyRow(body, s)));
    body.appendChild(list);
  }

  function historyRow(body, session) {
    const row = mk('div', 'hist-item');
    const main = mk('div', 'hist-main');
    main.appendChild(mk('div', 'hist-title', session.title || 'Untitled session'));
    const meta = mk('div', 'hist-meta');
    meta.appendChild(mk('span', 'hist-when', relTime(session.created_at_us)));
    const n = session.artifact_count || 0;
    meta.appendChild(mk('span', 'hist-size', n + (n === 1 ? ' line' : ' lines')));
    if (session.consent_class === 'sensitive') {
      meta.appendChild(mk('span', 'hist-chip sensitive', 'Sensitive'));
    }
    main.appendChild(meta);
    row.appendChild(main);

    const actions = mk('div', 'hist-actions');
    const openBtn = mk('button', 'btn btn-secondary hist-open', 'Open');
    openBtn.type = 'button';
    openBtn.addEventListener('click', () => openSavedSession(body, session.id));
    actions.appendChild(openBtn);
    const delBtn = mk('button', 'btn btn-secondary hist-del', 'Delete');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => confirmDeleteSession(session, row, actions, body));
    actions.appendChild(delBtn);
    row.appendChild(actions);
    return row;
  }

  // Inline confirm (no window.confirm, which is disallowed here): swap the row's
  // actions for a "Delete?" affordance with confirm/cancel.
  function confirmDeleteSession(session, row, actions, body) {
    actions.innerHTML = '';
    actions.appendChild(mk('span', 'hist-confirm', 'Delete?'));
    const yes = mk('button', 'btn btn-danger hist-del-yes', 'Delete');
    yes.type = 'button';
    yes.addEventListener('click', () => deleteSavedSession(body, session.id));
    const no = mk('button', 'btn btn-secondary hist-del-no', 'Cancel');
    no.type = 'button';
    no.addEventListener('click', () => fillHistory(body)); // re-render restores the row
    actions.appendChild(yes);
    actions.appendChild(no);
  }

  function deleteSavedSession(body, id) {
    if (typeof fetch !== 'function') return;
    fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.quota) renderQuota(data.quota); // freed a slot → meter updates
        if (openModalKind === 'history') fillHistory(body);
      })
      .catch(() => {
        if (openModalKind === 'history') fillHistory(body);
      });
  }

  // Show an error state inside the History popup with a Back affordance, instead
  // of silently leaving the list unchanged. A silent no-op here is what makes a
  // failed Open look like a dead button (e.g. a stale server with no
  // /api/sessions/:id route returns 404) — always give the user feedback + a way out.
  function renderHistoryError(body, message) {
    body.innerHTML = '';
    const back = mk('button', 'btn btn-secondary hist-back', '← Back to saved sessions');
    back.type = 'button';
    back.addEventListener('click', () => fillHistory(body));
    body.appendChild(back);
    body.appendChild(mk('p', 'sources-empty', message));
  }

  function openSavedSession(body, id) {
    if (typeof fetch !== 'function') return;
    fetch('/api/sessions/' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (openModalKind !== 'history') return; // user switched popups — drop it
        if (!data || !data.session) {
          renderHistoryError(body, 'Could not open this saved session — please try again.');
          return;
        }
        renderSavedSession(body, data.session, data.artifacts || []);
      })
      .catch(() => {
        if (openModalKind === 'history') {
          renderHistoryError(body, 'Could not open this saved session — please try again.');
        }
      });
  }

  // Render ONE saved session read-only: its transcript rebuilt from the stored
  // transcript_segment artifacts. This is inert — it never touches the live model,
  // the WebSocket, or the live transcript DOM (F1 §5).
  function renderSavedSession(body, session, artifacts) {
    body.innerHTML = '';
    const back = mk('button', 'btn btn-secondary hist-back', '← Back to saved sessions');
    back.type = 'button';
    back.addEventListener('click', () => fillHistory(body));
    body.appendChild(back);

    body.appendChild(mk('h3', 'hist-detail-title', session.title || 'Untitled session'));
    const n = session.artifact_count || 0;
    const metaText =
      relTime(session.created_at_us) + ' · ' + n + (n === 1 ? ' item' : ' items') +
      (session.consent_class === 'sensitive' ? ' · Sensitive' : '');
    body.appendChild(mk('p', 'hist-detail-meta', metaText));

    // Export this saved session as Markdown (recap + concepts + insights + transcript).
    const exportBtn = mk('button', 'btn btn-secondary hist-export', 'Export as Markdown');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', () =>
      downloadMarkdown(markdownFromArtifacts(session.title || 'Aizen session', artifacts || [])),
    );
    body.appendChild(exportBtn);

    const all = artifacts || [];
    const by = (k) => all.filter((a) => a && a.kind === k);
    let rendered = false;

    // Recap.
    const sum = by('session_summary')[0];
    if (sum && sum.payload && sum.payload.text) {
      rendered = true;
      body.appendChild(mk('h4', 'hist-section', 'Recap'));
      body.appendChild(mk('p', 'summary-text', sum.payload.text));
      if (Array.isArray(sum.payload.bullets) && sum.payload.bullets.length) {
        const ul = mk('ul', 'summary-bullets');
        sum.payload.bullets.forEach((b) => ul.appendChild(mk('li', null, String(b))));
        body.appendChild(ul);
      }
    }

    // Concepts.
    const cards = by('concept_card');
    if (cards.length) {
      rendered = true;
      body.appendChild(mk('h4', 'hist-section', 'Concepts (' + cards.length + ')'));
      const list = mk('div', 'concept-list');
      cards.forEach((a) => {
        const c = a.payload || {};
        const card = mk('div', 'concept-card');
        const head = mk('div', 'cc-head');
        head.appendChild(mk('span', 'cc-name', c.canonical_name || c.surface_form || 'Concept'));
        if (c.kind) head.appendChild(mk('span', 'cc-kind cc-kind-' + c.kind, CARD_KIND_LABEL[c.kind] || 'concept'));
        card.appendChild(head);
        if (c.definition_short) card.appendChild(mk('p', 'cc-def', c.definition_short));
        list.appendChild(card);
      });
      body.appendChild(list);
    }

    // Insights, grouped by type.
    const ins = by('insight_item');
    if (ins.length) {
      rendered = true;
      body.appendChild(mk('h4', 'hist-section', 'Insights (' + ins.length + ')'));
      const list = mk('div', 'insight-list');
      INSIGHT_GROUPS.forEach((g) => {
        const items = ins.filter((a) => a.payload && a.payload.insight_type === g.type);
        if (!items.length) return;
        const group = mk('div', 'insight-group insight-group-' + g.type);
        const h = mk('div', 'ig-head');
        h.appendChild(mk('span', 'ig-label', g.label));
        h.appendChild(mk('span', 'ig-count', String(items.length)));
        group.appendChild(h);
        items.forEach((a) => {
          const it = mk('div', 'insight-item insight-' + g.type);
          it.appendChild(mk('span', 'ii-text', a.payload.text || ''));
          group.appendChild(it);
        });
        list.appendChild(group);
      });
      body.appendChild(list);
    }

    // Transcript.
    const segs = by('transcript_segment');
    if (segs.length) {
      rendered = true;
      body.appendChild(mk('h4', 'hist-section', 'Transcript'));
      const stream = mk('div', 'hist-transcript');
      segs.forEach((a) => {
        const p = a.payload || {};
        const line = mk('div', 'line final');
        line.appendChild(mk('span', 'who', (p.who || 'Speaker') + ':'));
        line.appendChild(mk('span', 'txt', ' ' + (p.text || '')));
        stream.appendChild(line);
      });
      body.appendChild(stream);
    }

    if (!rendered) {
      body.appendChild(mk('p', 'sources-empty', 'This saved session has no saved content.'));
    }
  }

  // ---- Markdown export -----------------------------------------------------
  // Build a Markdown document for the LIVE session (what's on screen now) — works
  // for anyone, signed in or not. The saved-session view exports from its artifacts.
  function buildLiveMarkdown() {
    const transcript = [];
    for (const line of model.transcript.values()) {
      if (line.is_final && line.text) transcript.push({ who: line.who, text: line.text });
    }
    return markdownDoc('Aizen session', {
      summary: model.summary,
      concepts: [...model.cards.values()],
      insights: [...model.insights.values()],
      transcript,
    });
  }

  // Build the same Markdown from a saved session's stored artifacts.
  function markdownFromArtifacts(title, artifacts) {
    const by = (k) => (artifacts || []).filter((a) => a && a.kind === k);
    const sum = by('session_summary')[0];
    return markdownDoc(title, {
      summary: sum ? sum.payload : null,
      concepts: by('concept_card').map((a) => a.payload || {}),
      insights: by('insight_item').map((a) => a.payload || {}),
      transcript: by('transcript_segment').map((a) => a.payload || {}),
    });
  }

  function markdownDoc(title, d) {
    const out = ['# ' + title, ''];
    if (d.summary && d.summary.text) {
      out.push('## Recap', '', d.summary.text, '');
      (d.summary.bullets || []).forEach((b) => out.push('- ' + b));
      if (d.summary.bullets && d.summary.bullets.length) out.push('');
    }
    if (d.concepts && d.concepts.length) {
      out.push('## Concepts', '');
      d.concepts.forEach((c) => {
        const name = c.canonical_name || c.surface_form || 'Concept';
        out.push('- **' + name + '**' + (c.definition_short ? ' — ' + c.definition_short : ''));
      });
      out.push('');
    }
    if (d.insights && d.insights.length) {
      out.push('## Insights', '');
      INSIGHT_GROUPS.forEach((g) => {
        const items = d.insights.filter((i) => i.insight_type === g.type);
        if (!items.length) return;
        out.push('### ' + g.label, '');
        items.forEach((i) => out.push('- ' + i.text + (i.owner_speaker_id ? ' _(' + i.owner_speaker_id + ')_' : '')));
        out.push('');
      });
    }
    if (d.transcript && d.transcript.length) {
      out.push('## Transcript', '');
      d.transcript.forEach((l) => out.push('**' + (l.who || 'Speaker') + ':** ' + (l.text || '')));
      out.push('');
    }
    return out.join('\n');
  }

  function downloadMarkdown(md) {
    if (typeof Blob !== 'function' || typeof URL === 'undefined' || !URL.createObjectURL) return;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aizen-session.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderOpenModal() {
    if (!els.modalBody || !els.modalTitle) return;
    // Salvage any relocated live card BEFORE wiping the body (innerHTML='' would
    // orphan it), so switching directly between focus popups never strands a node.
    restoreFocusNode();
    els.modalBody.innerHTML = '';
    setModalFocus(false);
    if (openModalKind === 'providers') {
      els.modalTitle.textContent = 'Providers & plan limits';
      els.modalBody.appendChild(buildProvidersBody());
    } else if (openModalKind === 'settings') {
      els.modalTitle.textContent = 'Account';
      els.modalBody.appendChild(buildSettingsBody());
    } else if (FOCUS_SECTIONS[openModalKind]) {
      const def = FOCUS_SECTIONS[openModalKind];
      els.modalTitle.textContent = def.title;
      setModalFocus(true);
      moveFocusInto(def.id, els.modalBody); // relocate the live card; stays live
      // The graph sizes to its container — re-fit once it has moved into the modal.
      if (openModalKind === 'graph' && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(renderGraph);
      }
    } else if (openModalKind === 'sources') {
      els.modalTitle.textContent = 'Sources';
      setModalFocus(true);
      els.modalBody.appendChild(buildSourcesBody());
    } else if (openModalKind === 'history') {
      els.modalTitle.textContent = 'Saved sessions';
      setModalFocus(true);
      els.modalBody.appendChild(buildHistoryBody());
    }
  }

  function openModal(kind) {
    openModalKind = kind;
    renderOpenModal();
    show(els.modalOverlay, true);
  }
  function closeModal() {
    const wasGraph = openModalKind === 'graph';
    if (wasGraph) closeGraphPopover(); // don't strand a node popover as the graph re-fits
    openModalKind = null;
    restoreFocusNode(); // put any relocated live card back in the dashboard
    if (els.modalBody) els.modalBody.innerHTML = '';
    setModalFocus(false);
    show(els.modalOverlay, false);
    if (wasGraph) scheduleRender('graph'); // re-fit the graph back to its inline size
    // Back to the full dashboard → reflect that as the active ("Live Session") tab.
    const live = document.querySelector('[data-view="live"]');
    if (live) {
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      live.classList.add('active');
    }
  }

  if (els.modalClose) els.modalClose.addEventListener('click', closeModal);
  if (els.graphExpand) els.graphExpand.addEventListener('click', () => openModal('graph'));
  if (els.exportBtn) els.exportBtn.addEventListener('click', () => downloadMarkdown(buildLiveMarkdown()));
  if (els.summaryRefresh) els.summaryRefresh.addEventListener('click', requestRecap);
  if (els.modalOverlay) {
    els.modalOverlay.addEventListener('click', (e) => {
      if (e.target === els.modalOverlay) closeModal(); // backdrop click only
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (closeGraphPopover()) return; // dismiss an open node popover before any modal
    if (openModalKind) closeModal();
  });

  bootAccount();
  // F4 — offer a one-click reconnect if a vault handle was persisted, but only
  // when the Obsidian integration is enabled (off + hidden by default).
  if (obsidianEnabled()) tryRestoreObsidian();
})();
