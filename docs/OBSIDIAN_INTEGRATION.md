# Obsidian Integration — How It Works

> Feature **F4 — "Connect your Obsidian vault"** (see `New_Feature.md` §223+).
> This document explains how the Obsidian connector is wired into Aizen, how it
> connects to a vault, how a vault's notes end up grounding the AI's answers, and
> whether it works on other people's computers.

---

## 1. TL;DR

- An Obsidian vault is **just a folder of markdown notes**, so the integration is a
  thin **client-side, browser-only** reader. There is **no Obsidian plugin, no
  server-side filesystem access, and no Obsidian account/login** involved.
- On the common path (Chromium-family browsers) the user clicks **"Connect Obsidian
  vault"**, the browser's **File System Access API** (`showDirectoryPicker()`) opens a
  native folder picker, the user selects their vault folder, and Aizen reads every
  `*.md` file **read-only**, in memory, in the browser.
- Every note is poured into the shared **S0 source library** (`sources.js`), chunked,
  and indexed with BM25-lite retrieval. Per question/sentence, only the **top-k
  relevant chunks** are shipped to the server as `user_sources`, where they ground the
  explanation/answer and appear as **`obsidian`-typed citations** (note path shown,
  🔮 icon).
- **Privacy by design:** note text stays in the browser, in memory, for the session.
  Nothing is written back to the vault (read-only always). Only the few selected
  chunks ride each request; raw note text is never logged. Server-side persistence is
  **opt-in only**.
- **Portability:** it works on *anyone's* computer that runs a Chromium-based browser
  (Chrome, Edge, Brave, Opera, Arc) on desktop. Firefox/Safari and mobile fall back to
  a **folder-upload** path that works but can't auto-reconnect. No File System Access
  API at all → the UI degrades gracefully to the upload fallback.

---

## 2. Where the code lives

| File | Role |
|------|------|
| `packages/server/public/obsidian.js` | **The connector seam.** `window.AizenObsidian`. The 4 providers (FS-Access, Upload, REST, Null), markdown parsing, ignore rules, and IndexedDB handle persistence. Plain ES2017, no build step. |
| `packages/server/public/sources.js` | **The S0 source library** (`window.AizenSources`). Chunking + BM25-lite retrieval shared by F2 (paste), F3 (files), and F4 (Obsidian). |
| `packages/server/public/client.js` | **The UI + wiring.** The "Connect Obsidian" card/state-machine, connect/re-sync/disconnect handlers, indexing loop, and `userSourcesForSend()` which calls `selectFor()` per request. |
| `packages/server/public/index.html` | Loads `sources.js` → `obsidian.js` → `client.js` (in that order). |
| `packages/server/src/index.ts` | Serves `/obsidian.js`; `coerceUserSources()` validates/bounds the incoming `user_sources` (accepts `origin: 'obsidian'`). |
| `packages/intel-worker/src/explain.ts` | Folds `user_sources` into the explain/answer/follow-up prompts; emits `type:'obsidian'` citations via `userCitation()`. |
| `packages/contracts/src/user-source.ts` | `UserSource` contract — `origin: 'paste' \| 'file' \| 'obsidian'`. |
| `packages/contracts/src/sentence-explanation.ts` | Citation `type: 'web' \| 'user' \| 'file' \| 'obsidian'`. |
| `packages/contracts/src/account.ts` | `StoredSource` (`origin` includes `'obsidian'`) — the **opt-in** account persistence shape. |

---

## 3. The connection model — a provider seam (BD-03)

The integration follows the same **"always-callable, no branching at call sites"**
seam pattern as `WebSearchProvider` and `AuthSeam`. Every provider implements one
interface (`window.AizenObsidian`):

```js
interface ObsidianProvider {
  connect(): Promise<{ vaultName }>;
  listNotes(): Promise<Array<{ path }>>;
  readNote(path): Promise<string>;          // raw markdown (read-only)
  status(): 'connected' | 'disconnected' | 'unsupported';
}
```

There are **four** implementations, chosen by environment via `makeProvider(opts)`:

| Provider | When it's used | Backed by | Reconnect? |
|----------|----------------|-----------|------------|
| **`FileSystemObsidianProvider`** | Chromium desktop (the "zero-install, all users" path) | File System Access API **directory handle** (`showDirectoryPicker()`) | ✅ handle persisted in IndexedDB → one-click re-grant |
| **`UploadObsidianProvider`** | Firefox / Safari / no FS-Access | `<input type="file" webkitdirectory multiple>` FileList | ❌ user re-picks each session |
| **`RestApiObsidianProvider`** | *Phase 2 stub* — power users with the Obsidian **Local REST API** plugin | `fetch` to `https://127.0.0.1:27124` + API key | n/a (live) — **not fully wired; documented as a later upgrade, not the "all users" path** |
| **`NullObsidianProvider`** | Unsupported browser | nothing | n/a — UI shows the upload fallback |

`makeProvider()` decision order (in `obsidian.js`):
1. `opts.files` → **Upload** provider (the webkitdirectory fallback).
2. `opts.handle` / `opts.pickDirectory` → **FileSystem** provider (also how tests
   inject a mock handle).
3. `window.showDirectoryPicker` exists → **FileSystem** provider driving the native
   picker.
4. otherwise → **Null** provider.

Because the call sites never branch on provider type, the UI code (`connectObsidian`,
`indexObsidian`, `resyncObsidian`) is identical regardless of which path the browser
took.

---

## 4. How it connects, step by step

### 4a. Chromium path (the common, zero-install case)

1. User opens the **Sources** tab → **Obsidian vault** card → clicks **"Connect
   Obsidian vault"** (`buildObsidianSection()` in `client.js`).
2. `connectObsidian({})` → `AizenObsidian.makeProvider({})` builds a
   `FileSystemObsidianProvider` whose `pickDirectory` calls `window.showDirectoryPicker()`.
3. `provider.connect()`:
   - opens the **native OS folder picker**; the user selects the vault root folder;
   - calls `requestPermission(handle)` to get **read** permission;
   - resolves `{ vaultName }` (the folder name).
4. The directory **handle is persisted to IndexedDB** (`aizen-obsidian` DB) so the next
   visit can reconnect with one click.
5. `indexObsidian(provider)` runs:
   - `listNotes()` recursively walks the folder (`dir.entries()` async iterator),
     collecting every `*.md` path and **skipping `.obsidian/`, `.trash/`, `.git/`, and
     all dotfiles/dotdirs** (`isIgnoredName`). Capped at **4,000 notes** (UI) / 5,000
     (provider) to bound a pathological vault.
   - For each note: `readNote(path)` → `parseMarkdown(raw)` (strips a leading YAML
     `---…---` frontmatter block, keeps headings/body; `[[wikilinks]]` left as plain
     tokens) → `AizenSources.addDoc({ origin:'obsidian', title: notePath, path, text })`.
   - Coarse progress is reported every 50 notes.
6. The card switches to **Connected (vault name · N notes · M chunks)** with **Re-sync**
   and **Disconnect** buttons.

### 4b. Fallback path (Firefox / Safari / no FS-Access)

- The card shows an **"Upload vault folder"** button backed by
  `<input type="file" webkitdirectory multiple>`.
- Selecting the vault folder hands a `FileList` to `connectObsidian({ files })` →
  `UploadObsidianProvider`, which applies the **same** ignore rules, markdown parsing,
  chunking, and indexing.
- **Limitation:** there is no persistent handle, so the user must **re-pick the folder
  each session** (the UI says so).

### 4c. Re-sync & Disconnect

- **Re-sync** (`resyncObsidian`): `removeByOrigin('obsidian')` clears the vault's docs,
  then re-indexes from the (still-held) provider — this is how you pick up edits, since
  there is **no live file-watching** on the Phase-1 path.
- **Disconnect** (`disconnectObsidian`): clears the vault's docs, drops the provider,
  and **deletes the persisted IndexedDB handle**.
- **Reconnect on return visit** (`tryRestoreObsidian` → `reconnectObsidian`): on boot,
  if a handle was persisted, the card offers **"Reconnect Obsidian vault"**; clicking it
  re-requests read permission (one OS prompt) and re-indexes — no folder re-pick needed.

---

## 5. How a vault note actually grounds an answer (the data flow)

```
Obsidian folder (*.md)
   │  read-only, in browser
   ▼
obsidian.js  parseMarkdown()         ── strip YAML, keep headings/body
   ▼
sources.js   addDoc(origin:'obsidian', title=notePath, text)
   │           └─ chunkText(): ~700–1,100 char, markdown-aware, overlapping chunks
   ▼
sources.js   selectFor(queryText)    ── BM25-lite top-k for the CURRENT sentence/question
   │           └─ bounded: ≤ 8 chunks/request, ≤ 12 global, ≤ 24 KB, ≤ 600 chars/chunk
   ▼
client.js    userSourcesForSend(text) → ws.send({type:'explain'|'followup', user_sources:[…]})
   ▼
server index.ts  coerceUserSources()  ── validate, bound (≤ 64 KB aggregate), keep origin
   ▼
intel-worker explain.ts
   ├─ buildExplainPrompt / buildAnswerPrompt / buildFollowupPrompt  ── notes folded in as
   │                                                                   "authoritative context"
   └─ userCitation()  ── origin:'obsidian' → citation type:'obsidian'
   ▼
client.js  renders a 🔮 chip showing the note path (read-only, no link)
```

Key points:

- **Retrieval, not dumping.** A 2,000-note vault is *not* shipped wholesale. Each note
  is chunked, and only the few chunks that lexically match the current question/sentence
  (BM25-lite over the chunk corpus, tie-broken by recency) are sent. This keeps every
  request within a small grounding budget.
- **Works with no Tavily key.** Because user sources are independent grounding, a
  question can be answered **purely from the vault** even when web search is disabled —
  the answer fires whenever there's *any* grounding (web **or** user).
- **Citations carry provenance.** An Obsidian-grounded answer renders a labeled chip
  (`🔮 <note path>`) so it's clear the answer used the vault. These owned chips are
  always shown (not subject to the web-citation limit).

---

## 6. Persistence — two independent layers

1. **Reconnect handle (IndexedDB, client-only).** Only the FS-Access **directory
   handle** is stored (DB `aizen-obsidian`, store `handles`, key `vault`) — *not the
   note text*. It enables one-click reconnect. Best-effort and fully guarded: absent
   IndexedDB (private mode, the test VM) is a silent no-op. The upload fallback can't
   persist a handle at all.

2. **Account-saved notes (server, opt-in).** The `StoredSource` contract and
   `/api/sources` endpoints accept `origin:'obsidian'`, so a note *can* be saved to a
   signed-in account (re-loads into the library next visit). This is **opt-in and
   byte-quota-gated** (fail-closed). In normal Phase-1 use the vault is **re-read from
   disk each session** rather than stored server-side — the default posture keeps highly
   personal vault content client-side and in-memory only.

---

## 7. Privacy & security (read-only, bounded, not logged)

- **Read-only, always.** No provider ever writes to the vault. There is no write/sync
  code path. Clicking a citation does nothing destructive.
- **Ignore rules honored.** `.obsidian/` (config), `.trash/` (deleted notes), `.git/`,
  and all dotfiles/dotdirs are skipped, in both the FS-Access walk and the upload
  filter. (`.aizenignore` is a documented future add — the rule has one home in
  `isIgnoredName`.)
- **Bounded everywhere.** Per-chunk ≤ ~1,100 chars; ≤ 400 chunks/doc; ≤ ~4,000 notes;
  library ≤ 32 MB of text; per request ≤ 8–12 chunks / ≤ 24 KB; server aggregate ≤ 64
  KB. A giant vault can't exhaust memory or the prompt.
- **Minimal egress, no raw logs.** Only the S0-selected chunks leave the browser, only
  with a request; raw note text is never logged server-side.
- **Phase-2 REST key** (if/when wired) is a localhost-only secret stored in the
  signed session/Settings, never logged.

---

## 8. Would it work on other people's computers?

**Yes — with a browser-dependent experience.** There is nothing machine-specific in the
integration: no install, no plugin, no per-machine config. What varies is *which path*
a given browser takes.

| Environment | Connect path | Works? | Reconnect across reloads? |
|-------------|--------------|--------|---------------------------|
| **Chrome / Edge / Brave / Opera / Arc — desktop** | Native folder picker (File System Access API) | ✅ **Zero-install, one click** | ✅ one-click re-grant (IndexedDB handle) |
| **Firefox — desktop** | `webkitdirectory` folder **upload** | ✅ | ❌ re-pick each session |
| **Safari — desktop** | `webkitdirectory` folder **upload** | ✅ (upload supported) | ❌ re-pick each session |
| **Mobile browsers** | Usually the upload fallback; folder upload support is spotty | ⚠️ Partial / device-dependent | ❌ |
| **Browser with neither API** | `NullObsidianProvider` | UI degrades to the upload fallback / explains why | ❌ |

Hard requirements for it to work on someone else's machine:

1. **The vault is local to that machine** and the user picks/uploads it in *their own*
   browser. This is a client-side reader — it cannot reach a vault on a different
   computer or a cloud sync that isn't mounted as a local folder. (Obsidian Sync's local
   copy works fine; it's just a folder.)
2. **A modern browser.** Chromium desktop gets the premium path; everything else gets
   the upload fallback (functional, just no auto-reconnect).
3. **HTTPS / secure context.** The File System Access API requires a secure context
   (`https://` or `localhost`). On `localhost` (how this app is typically run) that's
   satisfied; if deployed, it must be served over HTTPS for the Chromium path to be
   offered. Otherwise users fall to the upload path.
4. **Nothing else.** No Obsidian login, no plugin, no API key (the REST-plugin path is an
   *optional* Phase-2 power-user upgrade that is stubbed, not required).

Failure modes are handled gracefully: if `obsidian.js` didn't load, the card says so and
how to fix it; if the browser can't pick a folder, it shows the upload button with a
one-line "why"; an unreadable note is skipped and indexing continues; permission denied
or a cancelled picker returns to the idle/connected state with a friendly message.

---

## 9. What it intentionally does **not** do (Phase 1 scope)

- **No live file-watching** — edits are picked up via **Re-sync**, not automatically.
- **No write-back / two-way sync** — read-only, always.
- **No Dataview / canvas / plugin rendering**, no non-markdown attachments.
- **`[[wikilinks]]`** are kept as plain text tokens (not resolved into the linked note's
  body) for now.
- **No embedding/semantic retrieval** — lexical BM25-lite only (a server-side hybrid
  index is a later, separate effort).
- **REST API plugin path** is a present-but-stubbed seam, documented as an optional
  upgrade — not part of the "works for all users" guarantee.

---

## 10. One-paragraph summary

The Obsidian integration treats a vault as what it physically is — a folder of markdown
files — and reads it entirely in the browser through a swappable provider seam. On
Chromium desktop it's a true one-click, zero-install connect via the File System Access
API (with an IndexedDB-persisted handle for easy reconnect); everywhere else it falls
back to a folder upload. Notes are parsed, chunked, and BM25-indexed by the shared S0
library, and only the top-k chunks relevant to the current question are sent to the
server, where they ground the answer and show up as read-only `obsidian` citations
naming the note. It works on anyone's computer with a modern browser, requires no
plugin/login/key, never writes to the vault, keeps note text client-side and in-memory,
and never logs it raw.
