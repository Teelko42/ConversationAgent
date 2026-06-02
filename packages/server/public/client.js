/*
 * Aizen browser client. Two jobs:
 *   1) Capture the microphone, downsample to 16 kHz PCM16 mono, and stream the
 *      bytes to the server over a binary WebSocket (the server forwards them to
 *      Deepgram).
 *   2) Receive bus envelopes pushed back by the server and fold them into a live
 *      view: transcript (partials update in place, finalize), concept cards
 *      (skeleton → enriched, retracted cards disappear), and insights.
 *
 * No build step — plain ES2017 the browser runs directly.
 */
(() => {
  'use strict';

  const els = {
    status: document.getElementById('status'),
    mic: document.getElementById('mic'),
    transcript: document.getElementById('transcript'),
    cards: document.getElementById('cards'),
    insights: document.getElementById('insights'),
    hint: document.getElementById('hint'),
  };

  // ---- live model (mirrors web-client/render.ts fold) ----------------------
  const model = {
    transcript: new Map(), // segment_id -> latest line {rev, is_final, who, text}
    cards: new Map(), // card.id -> latest non-retracted card
    insights: new Map(), // insight.id -> insight
  };
  let mode = 'demo';

  function isF02(env) {
    return env && Object.prototype.hasOwnProperty.call(env, 'message_type');
  }

  function foldEnvelope(env) {
    if (!env) return;
    if (!isF02(env)) {
      // F01: a TranscriptSegment has these fields (an AudioFrame does not).
      if ('segment_id' in env && 'text' in env && 'is_final' in env) {
        model.transcript.set(env.segment_id, {
          rev: env.rev,
          is_final: env.is_final,
          who: env.speaker && env.speaker.display_name ? env.speaker.display_name : 'Speaker',
          text: env.text,
        });
      }
      return;
    }
    if (env.message_type === 'concept_card' && env.card) {
      const card = env.card;
      if (card.state === 'retracted') model.cards.delete(card.id);
      else model.cards.set(card.id, card);
    } else if (env.message_type === 'insight_item' && env.insight) {
      model.insights.set(env.insight.id, env.insight);
    }
    // kg_delta has no UI surface — ignore.
  }

  // ---- rendering -----------------------------------------------------------
  function render() {
    els.transcript.innerHTML = '';
    for (const line of model.transcript.values()) {
      const div = document.createElement('div');
      div.className = 'line ' + (line.is_final ? 'final' : 'partial');
      div.innerHTML = `<span class="who"></span><span class="txt"></span>`;
      div.querySelector('.who').textContent = line.who + ':';
      div.querySelector('.txt').textContent = ' ' + line.text;
      els.transcript.appendChild(div);
    }

    els.cards.innerHTML = '';
    for (const card of model.cards.values()) {
      const div = document.createElement('div');
      div.className = 'card';
      const webSrc = (card.sources || []).filter((s) => s.type === 'web' && s.url);
      div.innerHTML = `
        <span class="badge"></span>
        <div><span class="term"></span><span class="canon"></span></div>
        <p class="def"></p>
        <div class="src"></div>`;
      div.querySelector('.badge').textContent = card.state;
      div.querySelector('.term').textContent = card.surface_form;
      div.querySelector('.canon').textContent =
        card.canonical_name && card.canonical_name !== card.surface_form
          ? '— ' + card.canonical_name
          : '';
      div.querySelector('.def').textContent = card.definition_short || '';
      const src = div.querySelector('.src');
      webSrc.slice(0, 3).forEach((s) => {
        const a = document.createElement('a');
        a.href = s.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = s.title || s.url;
        src.appendChild(a);
        src.appendChild(document.createTextNode(' '));
      });
      els.cards.appendChild(div);
    }

    els.insights.innerHTML = '';
    for (const ins of model.insights.values()) {
      const div = document.createElement('div');
      div.className = 'insight';
      div.textContent = `• ${ins.insight_type}: ${ins.text}`;
      els.insights.appendChild(div);
    }
  }

  // ---- websocket -----------------------------------------------------------
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${wsProto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    els.status.textContent = 'connected';
  };
  ws.onclose = () => {
    els.status.textContent = 'disconnected';
    els.mic.disabled = true;
    stopMic();
  };
  ws.onerror = () => {
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
        els.mic.disabled = false;
        els.hint.textContent = 'Click "Start listening" and speak. Concept cards appear as terms are mentioned.';
      } else {
        els.mic.disabled = true;
        els.hint.textContent =
          'Demo mode: no Deepgram key, so a canned clip drives the pipeline. ' +
          (p.llm === 'anthropic'
            ? 'The card below is explained by the real Anthropic model.'
            : 'Add ANTHROPIC_API_KEY + DEEPGRAM_API_KEY to .env for the full live experience.');
      }
    } else if (msg.type === 'envelope') {
      foldEnvelope(msg.env);
      render();
    } else if (msg.type === 'error') {
      els.status.textContent = 'error: ' + msg.message;
    }
  };

  // ---- microphone capture --------------------------------------------------
  let audioCtx, source, processor, sink, micStream, capturing = false;

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

  async function startMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      els.hint.textContent = 'Microphone permission denied.';
      return;
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    // route through a muted sink so the processor runs without echoing to speakers
    sink = audioCtx.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(audioCtx.destination);
    processor.onaudioprocess = (e) => {
      if (!capturing || ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = floatToPcm16Downsampled(input, audioCtx.sampleRate);
      ws.send(pcm.buffer);
    };
    capturing = true;
    els.mic.textContent = '⏹ Stop listening';
    els.mic.classList.add('recording');
  }

  function stopMic() {
    capturing = false;
    if (processor) processor.onaudioprocess = null;
    try { if (processor) processor.disconnect(); } catch {}
    try { if (source) source.disconnect(); } catch {}
    try { if (sink) sink.disconnect(); } catch {}
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
    audioCtx = source = processor = sink = micStream = null;
    els.mic.textContent = '🎙 Start listening';
    els.mic.classList.remove('recording');
  }

  els.mic.addEventListener('click', () => {
    if (capturing) stopMic();
    else startMic();
  });
})();
