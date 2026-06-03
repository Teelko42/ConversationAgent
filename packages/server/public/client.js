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
  };

  // Free-text transcript filter (set by the top-bar search box). Empty = show all.
  let filterText = '';

  // ---- live model ----------------------------------------------------------
  const model = {
    transcript: new Map(), // segment_id -> latest line {rev, is_final, who, text}
    explanations: new Map(), // segment_id -> {state:'loading'|'done', ex?}
    followups: [], // ordered Q→A thread: {ask_id, segment_id, question, state, answer?, error?}
  };
  let mode = 'demo';
  let selected = null; // segment_id whose explanation is shown in the side panel
  const requested = new Set(); // segment_ids we've already asked the server to explain
  let askSeq = 0; // monotonic counter → unique ask_id per follow-up (match reply→thread)
  const FOLLOWUP_UI_TIMEOUT_MS = 45000; // client-side backstop so a follow-up never spins forever

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
    if (!env || isF02(env)) return; // only transcript (F01) has a UI surface now.
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
    }
  }

  // Ask the server to explain a sentence, at most once per segment. Used by both
  // the auto-answer path (final questions) and a manual click (any final line).
  function requestExplain(id, text) {
    if (requested.has(id)) return;
    requested.add(id);
    model.explanations.set(id, { state: 'loading' });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'explain', segment_id: id, text }));
    }
  }

  // ---- rendering -----------------------------------------------------------
  function renderTranscript() {
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

  // Reflect socket health on the sidebar connection chip (purely cosmetic).
  function setConn(state, text) {
    if (!els.connChip) return;
    els.connChip.classList.remove('online', 'offline');
    if (state) els.connChip.classList.add(state);
    const t = els.connChip.querySelector('.conn-text');
    if (t && text) t.textContent = text;
  }

  // Shared source-link row (reused by inline answers, the side panel, and the F1
  // follow-up thread) so web citations always render identically (INV-1/2).
  function buildSourceRow(sources, className, limit) {
    const src = document.createElement('div');
    src.className = className;
    (sources || []).slice(0, limit || 3).forEach((s) => {
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = s.title || s.url;
      src.appendChild(a);
      src.appendChild(document.createTextNode(' '));
    });
    return src;
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
    const id = lineEl.dataset.segmentId;
    const line = model.transcript.get(id);
    if (!line) return;
    selected = id;
    const exState = model.explanations.get(id);
    if (exState && exState.state === 'done') {
      renderExplanation(exState.ex);
    } else {
      showExplanationLoading(line.text);
      requestExplain(id, line.text);
    }
    renderTranscript();
  });

  function showExplanationLoading(sentence) {
    els.explanation.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'explain';
    div.innerHTML = `<p class="sentence"></p><p class="loading">Explaining…</p>`;
    div.querySelector('.sentence').textContent = sentence;
    els.explanation.appendChild(div);
  }

  function renderExplanation(ex) {
    if (!ex || ex.segment_id !== selected) return; // ignore stale/late replies
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
      ans.textContent = ex.answer || 'No confident answer found from the web sources.';
      if (!ex.answer) ans.classList.add('muted');
      div.appendChild(ans);

      div.appendChild(buildSourceRow(ex.sources, 'src', 3));
    }

    if (ex.state === 'degraded') {
      const note = document.createElement('p');
      note.className = 'degraded';
      note.textContent =
        'Demo/degraded — add ANTHROPIC_API_KEY (and TAVILY_API_KEY) to .env for real explanations.';
      div.appendChild(note);
    }

    els.explanation.appendChild(div);
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
      } else if (fu.state === 'error') {
        a.classList.add('muted');
        a.textContent = 'Could not answer: ' + (fu.error || 'unknown error');
      } else {
        const ans = fu.answer || {};
        const p = document.createElement('p');
        p.className = 'fu-answer';
        if (ans.answer) {
          p.textContent = ans.answer;
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
    const transcript = [];
    for (const line of model.transcript.values()) {
      if (line.is_final && line.text) transcript.push(line.text);
    }
    return { sentence, transcript: transcript.slice(-12) }; // cap to bound frame size
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
      if (fu.state === 'loading') {
        clearFollowupTimer(fu);
        fu.state = 'error';
        fu.error = message;
        changed = true;
      }
    }
    if (changed) renderFollowups();
  }

  function applyAnswer(askId, answer) {
    const fu = model.followups.find((f) => f.ask_id === askId);
    if (!fu) return;
    clearFollowupTimer(fu);
    fu.state = 'done';
    fu.answer = answer; // a FollowupAnswer {answer, sources, state, ...}
    renderFollowups();
  }

  function applyAnswerError(askId, message) {
    const fu = model.followups.find((f) => f.ask_id === askId);
    if (!fu) return;
    clearFollowupTimer(fu);
    fu.state = 'error';
    fu.error = message;
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
        const p = msg.providers || {};
        const tag = mode === 'live' ? '<span class="live">LIVE</span>' : '<span class="demo">DEMO</span>';
        els.status.innerHTML =
          `${tag} · stt: ${p.stt} · explanations: ${p.llm} · search: ${p.search}`;
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
        foldEnvelope(msg.env);
        renderTranscript();
      } else if (msg.type === 'explanation') {
        const ex = msg.explanation;
        if (ex && ex.segment_id) {
          model.explanations.set(ex.segment_id, { state: 'done', ex });
          renderTranscript(); // inline answer under the line
          if (ex.segment_id === selected) renderExplanation(ex); // full breakdown in panel
          updateFollowupEnabled(); // a sentence is explained → enable follow-ups
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
  const BTN = {
    mic: { el: () => els.mic, idleIco: '🎙', idleTxt: 'Mic', recIco: '⏹', recTxt: 'Stop mic' },
    sys: { el: () => els.sys, idleIco: '🖥', idleTxt: 'Computer audio', recIco: '⏹', recTxt: 'Stop computer' },
    both: { el: () => els.both, idleIco: '🎙🖥', idleTxt: 'Mic + computer', recIco: '⏹', recTxt: 'Stop both' },
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
        ico.textContent = active ? cfg.recIco : cfg.idleIco;
        txt.textContent = active ? cfg.recTxt : cfg.idleTxt;
      } else {
        // Fallback if the markup ever omits the spans: keep the old flat label.
        btn.textContent = active ? cfg.recIco + ' ' + cfg.recTxt : cfg.idleIco + ' ' + cfg.idleTxt;
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

  // Sidebar nav: highlight the clicked item, smooth-scroll to its section, and
  // collapse the drawer on mobile. data-target is the id of the section to reach.
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
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
})();
