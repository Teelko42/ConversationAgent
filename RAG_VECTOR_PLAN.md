# RAG / Vector Retrieval — Design Plan

> Status: **proposed (plan only)** · Branch target: TBD · Author: design pass 2026-06-06
> Decisions locked (per request): **server-side pgvector** · **Voyage AI embeddings** · **hybrid (vector + BM25), gated, BM25 stays the always-on fallback**.

## 0. TL;DR

Add **semantic retrieval** alongside the existing lexical (BM25-lite) retrieval. Embed
source chunks **at ingest** with Voyage AI, store the vectors in **Postgres + pgvector**,
and add a `/api/retrieve` route that embeds the query, runs a vector search **and** a
lexical search, and **fuses** them with Reciprocal Rank Fusion (RRF). The client calls
this route instead of the local BM25 picker **when** the user is signed in and the
embeddings key is present; otherwise it stays on today's in-browser BM25 — unchanged.

The whole thing hangs off one existing seam: everything still returns
**`UserSource[]`** (the shape `selectFor()` already returns and the explain/follow-up
engines already consume). Nothing downstream changes.

### Honest expectation-setting (read before building)

- **This is for recall quality, not speed.** Over your bounded corpus
  (`LIBRARY_MAX_BYTES = 32 MB`, a few thousand chunks) BM25-lite is already sub-ms, and a
  brute-force cosine scan over a few thousand vectors is *also* sub-ms. HNSW/IVF indexes
  only earn their keep at ~100k+ vectors. The gain from vectors is **semantic matching**
  (synonyms / paraphrase / intent), where BM25 needs literal word overlap.
- **It adds latency to the hot answer path.** Today retrieval is local + zero-network.
  Vectors require a **query-embedding round trip to Voyage** per query (~50–150 ms). That
  is a regression versus today on the Ultra-Speed path. §9 covers how to hide it.
- Therefore: **hybrid, gated, fail-open.** Vectors augment BM25; they never replace it,
  and any failure (no key, Voyage down, no Postgres) silently falls back to BM25.

---

## 1. Where this plugs into what exists today

| Concern | Today | After |
|---|---|---|
| Chunking | `sources.js` `chunkText()` (browser, ES2017) | + a server-side chunker on ingest (§4) |
| Selection | `sources.js` `selectFor()` — BM25-lite, client, in-memory | + `/api/retrieve` — vector + BM25 + RRF, server (§6) |
| What ships per request | top-k chunks as `user_sources` (`client.js:166`, `:1155`) | **unchanged** — still `UserSource[]` |
| Persistence | `StoredSource.text` rows (`sources` table) | + `source_chunks(text, embedding)` table (§3) |
| Gating | providers key-gated in `config.ts` (BD-03) | + `VOYAGE_API_KEY` gated the same way (§2) |
| Privacy | doc text client-only except selected chunks | signed-in chunk text already server-side as `StoredSource`; see §7 |

**The seam.** `client.js` → `userSourcesForSend(queryText)` (`client.js:192`) →
`AizenSources.selectFor()` → `UserSource[]`. The engines (`explain.ts:201/217/271/389`)
read that array and treat it as authoritative context. We swap *only* the middle: when
hybrid retrieval is available, `userSourcesForSend` awaits `/api/retrieve` and gets the
**same `UserSource[]` shape** back. `explain.ts`, the prompt builders, citations — all
untouched.

---

## 2. Provider seam — Voyage AI (key-gated, BD-03)

Mirror exactly how Tavily/Deepgram/Anthropic are gated in `config.ts`.

**`packages/server/src/config.ts`**
- `AppConfig`: add `voyageApiKey?: string;` and `embeddingModel: string;`
- `loadConfig()`: `voyageApiKey: envOpt('VOYAGE_API_KEY')`,
  `embeddingModel: envOpt('EMBEDDING_MODEL') ?? 'voyage-3'`
- `ProviderStatus`: add `embeddings: 'voyage' | 'off'`
- `providerStatus()`: `embeddings: cfg.voyageApiKey ? 'voyage' : 'off'`

**Model / dimensions.** `voyage-3` → **1024 dims** (lite = 512, large = 1024). Embedding
dimension is **baked into the DB column** (`vector(1024)`), so the model is *not* freely
swappable after data exists without a re-embed + column change. Pin it in config and
treat a model change as a migration. Voyage supports an `input_type` of
`"document"` (ingest) vs `"query"` (retrieval) — use both; it measurably improves recall.

**New module `packages/server/src/embeddings.ts`** — a tiny Voyage client (no SDK needed;
`POST https://api.voyageai.com/v1/embeddings`, `Authorization: Bearer <key>`):
- `embedDocuments(texts: string[]): Promise<number[][]>` — batched (Voyage takes up to
  128 inputs/call; chunk the batch), `input_type: 'document'`.
- `embedQuery(text: string): Promise<number[]>` — `input_type: 'query'`.
- Returns `null`/throws cleanly when no key → callers fall back to BM25 (fail-open).

`.env.example`: document `VOYAGE_API_KEY=` and `EMBEDDING_MODEL=voyage-3`.

---

## 3. Schema — Postgres + pgvector

Lives in the **PgAccountRepository** `SCHEMA` block (`repository-postgres.ts:35`), created
idempotently on `open()` exactly like the other tables.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS source_chunks (
  id          TEXT PRIMARY KEY,            -- `${source_id}_${chunk_idx}`
  account_id  TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  chunk_idx   INTEGER NOT NULL,
  text        TEXT NOT NULL,
  embedding   vector(1024),                -- NULL until embedded (fail-open backfill)
  tsv         tsvector,                    -- for the lexical arm (Postgres FTS)
  created_at_us BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_account ON source_chunks(account_id);
CREATE INDEX IF NOT EXISTS idx_chunks_source  ON source_chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv     ON source_chunks USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_vec
  ON source_chunks USING hnsw (embedding vector_cosine_ops);
```

Notes:
- **`embedding` is nullable** so a source can be stored even if embedding fails; the
  backfill (§8) fills it later. Rows with `NULL` embeddings just don't surface in the
  vector arm — BM25 still finds them.
- **`tsv`** powers the lexical arm server-side so retrieval is one DB round trip. Populate
  it on insert (`to_tsvector('english', text)`). Alternatively keep BM25 in JS — but
  doing it in Postgres keeps the route stateless and avoids loading all chunks into Node.
- **HNSW** is the index; over a small corpus it's overkill but free and future-proof.
- **Azure caveat:** on Azure Database for PostgreSQL Flexible Server, `vector` must be
  allowlisted via the `azure.extensions` server parameter before `CREATE EXTENSION`
  succeeds. Document this in `AZURE_SETUP.md`. If the extension is absent at `open()`,
  catch and **skip** the chunk tables (fail-open → app still boots on BM25-only).

**Repository interface** (`repository.ts`) — add, implemented by Pg now and SQLite later
(or SQLite no-ops → BM25 fallback locally):
- `addChunks(chunks: SourceChunk[]): Promise<void>`
- `deleteChunksForSource(accountId, sourceId): Promise<void>`
- `searchChunksVector(accountId, queryEmbedding, k): Promise<ScoredChunk[]>`
  → `ORDER BY embedding <=> $1 LIMIT k` (cosine distance; `<=>`)
- `searchChunksLexical(accountId, queryText, k): Promise<ScoredChunk[]>`
  → `WHERE tsv @@ plainto_tsquery('english', $1) ORDER BY ts_rank_cd(...) LIMIT k`
- `listChunklessSources(accountId, limit): Promise<StoredSource[]>` (backfill helper)

New contract `SourceChunk` in `packages/contracts/src/account.ts` (id, account_id,
source_id, chunk_idx, text, created_at_us — embedding stays DB-internal, never crosses the
wire).

---

## 4. Ingest path — chunk + embed when a source is saved

Hook into `AccountService.saveSource()` (`service.ts:266`) — it's already the single
choke point for every persisted source (paste / file / obsidian), already quota-checked,
already returns the `StoredSource`.

After the existing `repo.addSource(source)`:
1. `deleteChunksForSource()` (replace-safe: a re-save re-chunks).
2. **Chunk** `source.text` server-side (§4.1).
3. **Embed** the chunk texts via `embedDocuments()` (batched). On failure: log, leave
   `embedding = NULL`, continue (backfill retries).
4. `addChunks()` with text + embedding + `to_tsvector`.

Make steps 2–4 **fire-and-forget after the 201 response** (or a short `await` with a
timeout) so saving a 40-page PDF doesn't block the client on Voyage latency. The source is
usable on BM25 the instant it's stored; vectors light up a beat later.

### 4.1 Where chunking lives (the one real refactor)

`chunkText()` currently exists only in `sources.js` (browser). The server needs its own.
**Chunk identity is server-internal** (the route returns `UserSource`s with
server-generated ids), so the server chunker does **not** have to match the client's
indices — it just has to chunk *well*. Two options:

- **(A, recommended) Extract a shared TS module** `packages/contracts/src/chunk.ts`
  (or a small `@aizen/retrieval` package) with `chunkText()`/`tokenize()`, and have the
  server import it. The browser keeps `sources.js` as-is (no build step there) — accept
  that the two implementations are parallel ports of one algorithm. Single *spec*, two
  call sites.
- **(B) Independent server chunker.** Simplest; just port the ~60 lines. Fine because of
  the identity point above, but risks the two drifting in behaviour over time.

Recommend **A** for maintainability. Either way, reuse the existing bounds
(`CHUNK_TARGET=900`, `CHUNK_MAX=1100`, overlap=160, `MAX_CHUNKS_PER_DOC=400`).

---

## 5. (covered in 4) — Quota & cost

- **Storage quota** is unchanged — still metered by `StoredSource.bytes` (the extracted
  text). Vectors add storage but aren't billed to the user's byte quota (they're derived).
  Note the real DB footprint: 1024 floats × 4 B ≈ **4 KB/chunk** of vector + HNSW
  overhead; size the Postgres disk accordingly for large vaults.
- **Embedding $ cost** is at ingest, **once per chunk** (not per query) — cheap and
  bounded by the same source byte quota. Query embedding is one short call per question.
- Consider a per-tier gate: hybrid retrieval **on** for pro/team/enterprise, **off**
  (BM25) for free — reuses the `entitlement(tier)` table. Optional; decide in §13.

---

## 6. Query path — `/api/retrieve` (vector + BM25 + RRF)

New route in `accounts.ts` (same file as the other `/api/*` routes; account-scoped,
auth-gated identically — see the `/api/sources` block at `accounts.ts:447`).

```
POST /api/retrieve   { query: string, k?: number }   (signed-in only)
→ { sources: UserSource[] }
```

Handler:
1. `accountId` from cookie (else 401 → client falls back to local BM25).
2. If no `VOYAGE_API_KEY` **or** no pgvector → return `{ sources: [] }` with a header/flag
   so the client knows to use local BM25 (fail-open).
3. `qVec = embedQuery(query)` and `searchChunksLexical(query)` — **run concurrently**.
4. `searchChunksVector(qVec, 30)` (vector arm) + the lexical arm (30).
5. **Fuse with RRF** (`k_rrf = 60`): `score(c) = Σ 1/(k_rrf + rank_arm(c))` across the two
   ranked lists; sort desc; take top-k (default 8, matching
   `userSourcesForSend`'s `maxChunks: 8`).
6. Map winners → `UserSource[]` (`{ id: 'us_<sourceId>_<idx>', title, text, origin }`) —
   **identical shape** to `selectFor()` (`sources.js:411`), capped to the same
   `GLOBAL_MAX_BYTES`/`maxCharsPerChunk: 600` budget.

RRF is the right fusion choice: it needs no score normalization between the cosine-distance
and ts_rank scales, and it's a few lines.

---

## 7. Client wiring — behind `userSourcesForSend`

`packages/server/public/client.js` `userSourcesForSend()` (`client.js:192`) is the only
consumer to touch. Make it async-capable:

- If signed in **and** server reports `provider_status.embeddings === 'voyage'` (already
  surfaced by `/api/session`, `accounts.ts:267`): `await fetch('/api/retrieve', {query})`
  and use the returned `UserSource[]`.
- On non-200, empty result, timeout (~400 ms budget), or signed-out: **fall back to
  `lib.selectFor(queryText)`** exactly as today.

Because both call sites (`client.js:166` explain, `:1155` follow-up) build the request
body, they either `await` the async picker or pre-resolve sources just before send. Keep
the **legacy synchronous BM25** path 100% intact as the fallback — this is the safety net.

A subtle point: today retrieval is over the **live in-browser library** (which includes
sources not yet/never persisted — e.g. anonymous users, this-session pastes).
`/api/retrieve` only knows **persisted** sources. So the correct behaviour is **union**:
server hybrid results for persisted sources **+** local BM25 for anything in the library
that isn't persisted, deduped by source id. Simplest first cut: signed-in users with all
sources persisted use the server route; everyone else uses local BM25. Note this in §13.

---

## 8. Backfill — existing sources have no vectors

Sources saved before this ships (and any whose embedding failed) have `embedding = NULL`.
A small idempotent backfill:
- On server boot (or a `/admin`/cron task): `listChunklessSources()` in batches → chunk →
  `embedDocuments()` → `addChunks()`. Rate-limit to respect Voyage limits.
- Until backfilled, those sources are simply BM25-only — correct, just not yet semantic.
- Keep it resumable (process by `created_at_us`, skip rows that already have chunks).

---

## 9. Latency budget (protecting Ultra-Speed-V1)

Query embedding is the new cost on the hot path. Mitigations, in order:
1. **Parallelize** the query embed with the lexical arm and with any other request prep
   (it's independent of the transcript/web-search hops in `explain.ts`).
2. **Cache query embeddings** in-process keyed by the exact query string — the *explain*
   query is the sentence being explained, often re-issued (re-explain, follow-up on the
   same sentence). An LRU of a few hundred saves the round trip on repeats.
3. **Timeout + fall back** (~400 ms): if Voyage is slow, ship local BM25 results rather
   than stall the answer. Better a lexical answer now than a semantic answer late.
4. Voyage `voyage-3-lite` (512-d) is faster/cheaper if the quality delta is acceptable —
   A/B it. Dimension change = migration, so decide before backfilling at scale.

Net: with (1)+(2)+(3) the *typical* added latency on the answer path is ~0 (cache hit) to
~one short HTTP call, and never an open-ended stall.

---

## 10. Privacy & consent (team-09)

- **No new exposure for signed-in users.** Their `StoredSource.text` is *already* on the
  server (SQLite/Postgres). `source_chunks.text` is the same text re-shaped; the embedding
  is a derived vector. Same `consent_class` / `pii_present` / retention window applies —
  **cascade chunk deletion** with the source (delete in `deleteSource`, and on retention
  expiry) so vectors never outlive their source.
- **Anonymous / demo users are untouched.** No account ⇒ no `/api/retrieve` ⇒ retrieval
  stays 100% in-browser BM25, exactly as today. The privacy posture for the not-signed-in
  path is preserved byte-for-byte.
- **Voyage sees chunk text + queries.** That's a new third-party data flow. Gate it behind
  the key (no key ⇒ never called) and document it where Tavily/Deepgram are documented.
  Consider a tier/consent check before sending `sensitive` sources to Voyage.
- Retrieve route returns **only the top-k truncated chunks** (same budget as today) — never
  the full corpus, never raw vectors.

---

## 11. Failure modes (all fail-open to BM25)

| Failure | Behaviour |
|---|---|
| No `VOYAGE_API_KEY` | `/api/retrieve` returns empty; client uses local BM25 |
| pgvector not installed / no Postgres | chunk tables skipped at boot; BM25 only |
| Voyage error/timeout at ingest | source stored, `embedding = NULL`, backfill retries |
| Voyage error/timeout at query | route returns local-BM25 signal or empty; client falls back |
| Signed out | route 401; client uses local BM25 (today's path) |
| `sources.js` failed to load | existing legacy paste-array fallback (`client.js:201`) |

There is **no configuration in which retrieval breaks** — the worst case is "you get the
lexical results you already get today."

---

## 12. File-by-file change list

**New**
- `packages/server/src/embeddings.ts` — Voyage client (`embedDocuments`, `embedQuery`).
- `packages/contracts/src/chunk.ts` *(option A)* — shared `chunkText`/`tokenize`.
- `packages/contracts/src/source-chunk.ts` — `SourceChunk` contract.
- *(maybe)* `packages/server/src/retrieval.ts` — RRF fusion + `UserSource` mapping.

**Edited**
- `packages/server/src/config.ts` — `voyageApiKey`, `embeddingModel`, `ProviderStatus.embeddings`.
- `packages/accounts/src/repository.ts` — interface: `addChunks`, `deleteChunksForSource`,
  `searchChunksVector`, `searchChunksLexical`, `listChunklessSources`.
- `packages/accounts/src/repository-postgres.ts` — `SCHEMA` (extension + table + indexes),
  the five methods, cascade chunk delete in `deleteSource`.
- `packages/accounts/src/repository-sqlite.ts` + `repository.ts` (in-memory) — no-op /
  not-supported stubs (→ BM25 fallback locally).
- `packages/accounts/src/service.ts` — `saveSource()` chunk+embed hook; `deleteSource()`
  cascade; backfill helper.
- `packages/server/src/accounts.ts` — `POST /api/retrieve` route.
- `packages/server/public/client.js` — `userSourcesForSend()` async + server route + fallback.
- `.env.example`, `AZURE_SETUP.md` — Voyage key + Azure `azure.extensions` note.

---

## 13. Phasing & decisions still open

**Suggested phases**
1. **P1 — plumbing, no UI change:** config seam, schema, repo methods, embeddings client,
   ingest hook (fire-and-forget), `/api/retrieve`. Keep client on BM25. Verify vectors
   populate and the route returns sane results (curl/test).
2. **P2 — flip the client:** `userSourcesForSend` uses `/api/retrieve` with fallback;
   backfill existing sources.
3. **P3 — polish:** query-embedding cache, tier gating, A/B `voyage-3` vs `-lite`,
   union of server + local results.

**Open questions for you**
- **Tier gate?** Hybrid on for all signed-in users, or pro/team/enterprise only?
- **Local-source union (§7)?** Do P3 union now, or accept "signed-in + persisted ⇒ server,
  else local BM25" for v1?
- **Ingest blocking?** Fire-and-forget (recommended) vs. await-with-timeout so the 201
  reflects embedding status.
- **`voyage-3` (1024) vs `voyage-3-lite` (512)** as the starting model — affects the
  `vector(N)` column and backfill, so pick before P1's schema lands.

## 14. Out of scope (this plan)

- Reranking (Voyage `rerank-2` as a 3rd stage after RRF) — a clean later add.
- Cross-encoder / query expansion / HyDE.
- Vectorizing the live transcript or KG nodes (this is about BYO sources only).
- Migrating anonymous in-browser retrieval to vectors (would need client-side embedding;
  deliberately not pursued — see the original architecture fork).
