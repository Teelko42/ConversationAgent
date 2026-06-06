---
title: The Browser Client
aliases: [Client, client.js, Browser UI, Frontend, Audio Capture Browser, PCM16]
tags: [app, frontend, f03]
created: 2026-06-05
---

# The Browser Client (`client.js`)

> [!abstract] One file, no build step
> The entire dashboard is `packages/server/public/client.js` (~2,800 lines), plain ES2017
> wrapped in a single IIFE — **no bundler, no framework**. Its three jobs: capture the mic
> → 16 kHz PCM16 → stream over a binary WebSocket; fold inbound transcript envelopes into a
> live view; and on a click of a finished sentence, ask the server to **explain** it.
> Loads after `sources.js` and `obsidian.js` so `window.AizenSources` / `window.AizenObsidian`
> exist first.

> [!note] Defensive by construction
> Every DOM lookup (`els`) and every `fetch`/API call is **guarded**, so the core
> capture→transcribe→explain pipeline never breaks if markup, network, or a helper script
> is missing — this is also why it runs under a headless-DOM test harness (no layout
> engine). See [[Deployment and Testing]].

---

## The state model

A single `model` object is the source of truth; render functions rebuild the DOM from it:

```js
model = {
  transcript:   new Map(),   // segment_id -> { rev, is_final, who, text }
  explanations: new Map(),   // segment_id -> { state:'loading'|'done', ex? }
  followups:    [],          // ordered Q -> A thread
  userSources:  [],          // legacy paste fallback
  fileEntries:  [],          // F3 local-file rows
  obsidian:     { ... },     // F4 vault state
}
```

---

## Major sections

| Area | Key functions | Notes |
|---|---|---|
| **Transcript + auto-explain** | `foldEnvelope`, `requestExplain`, `looksLikeQuestion` | a final line that *looks like a question* auto-explains (once per segment) |
| **BYO sources producer** | `userSourcesForSend(queryText)`, `srcLib()` | calls `AizenSources.selectFor(text, {maxChunks:8, maxCharsPerChunk:600})` → [[S0 - Source Library and Retrieval]] |
| **Local files** | `addFiles`, `extractFileText`, `loadPdfLib`, `extractPdfText` | text via `file.text()`, PDF via vendored pdf.js → [[F3 - Local File Sources]] |
| **Obsidian** | `connectObsidian`, `indexObsidian`, `resyncObsidian`, `tryRestoreObsidian` | → [[F4 - Obsidian Vault Connection]] |
| **Account persistence** | `bootStoredSources`, `saveSourceToAccount`, `loadStoredSource` | talks to `/api/sources` → [[The Account System]] |
| **Rendering** | `renderTranscript`, `renderExplanation`, `buildSourceRow`, `sourceChip` | provenance-icon'd chips (🔮 obsidian / 📄 file / ✏️ note) |
| **Follow-ups (F1)** | `submitFollowup`, `followupContext`, `applyAnswer` | ships `{sentence, transcript}` so a follow-up survives reconnect → [[F1 - Follow-up Answers]] |
| **WebSocket** | `connect`, `ws.onmessage` dispatch | auto-reconnect with exponential backoff (500 ms → 5 s) |
| **Audio capture** | `startCapture`, `floatToPcm16Downsampled`, `getMicStream`, `getSystemStream` | see below |
| **Document PiP** | `popOut`, `movePanelsInto`, `copyStylesInto` | → [[Document Picture-in-Picture]] |
| **Account UI** | `renderAccount`, `bootAccount`, `saveSession`, `signOut` | sign-in menu, quota, history popups |
| **Theme / modals** | `setTheme`, `openModal`, focus-section relocation | light default + warm dark → [[UI Redesign]] |

Boot order (bottom of file): `connect()`, then `bootAccount()`, then
`if (obsidianEnabled()) tryRestoreObsidian()`.

---

## Audio capture & the PCM16 downsampling

This is where the **real microphone** is captured (Lane B's `MockClipSource` only drives
the demo spine). One engine, three sources:

| Source | API | Notes |
|---|---|---|
| **mic** | `getUserMedia({audio})` | the default |
| **sys** | `getDisplayMedia({video, audio})` | video requested so the picker appears, then blanked; audio-only consumed |
| **both** | mic + system, mixed | each gain-attenuated to `0.7` to avoid clipping |

The pipeline uses a **`ScriptProcessor`** (4096-frame buffer) routed through a muted sink.
On each audio process it box-averages the source window down to **16 kHz mono** and ships
Int16 PCM as a binary WebSocket frame:

```js
function floatToPcm16Downsampled(input, inRate) {  // ratio = inRate / 16000
  // box-average source windows → 16 kHz, clamp to [-1,1], scale to Int16
  ...
  ws.send(pcm.buffer);   // binary frame → server bridges to Deepgram
}
```

> [!warning] The resume gotcha
> The code explicitly `await audioCtx.resume()` when the context boots `'suspended'` —
> otherwise no PCM flows after a stop→start without a page refresh. Track `ended` events
> ("Stop sharing") tear capture down cleanly; `stopCapture()` returns a Promise so a
> restart awaits full teardown.

---

## Inbound message dispatch

`ws.onmessage` is the single inbound switch (mirrors [[The Server|the server's protocol]]):

```js
status      → toggle LIVE/DEMO badge, enable buttons
envelope    → foldEnvelope(env) → renderTranscript()
explanation → model.explanations.set(...); render inline + side panel
answer / answer_error → match by ask_id → applyAnswer()
explain_error → drop loading state, allow retry
error       → fatal: stop reconnecting
```

---

## Resilience patterns

> [!info] Why the UI survives a flaky connection
> - **Auto-reconnect** with exponential backoff; gives up only on a fatal server `error`.
> - **Reconnect-proof grounding** — because each WebSocket is a fresh, empty server
>   session, follow-ups ship their own context and `user_sources` ride every request, so
>   BYO grounding survives a reconnect with **no server-side session state** (see
>   [[The Server]]).
> - **Move-not-clone PiP** — popping out *adopts* the live nodes, so listeners and the
>   render loop keep working in the new window ([[Document Picture-in-Picture]]).

---

## Related
- [[The Server]] — the other end of the WebSocket
- [[S0 - Source Library and Retrieval]] — `sources.js`, loaded before this
- [[F3 - Local File Sources]] · [[F4 - Obsidian Vault Connection]] · [[Document Picture-in-Picture]]
- [[The Account System]] — the sign-in / quota / history UI
- [[UI Redesign]] — the visual language this renders
