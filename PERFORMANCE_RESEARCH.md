# Making "answer a question" faster — analysis + researched plan

> **Status (2026-06-05): recommendations #1, #2, #3 are IMPLEMENTED.** The answer
> now streams token-by-token over the WebSocket (`answer_delta` frames; the
> explanation paints first via `explanation_partial`); the web search runs
> concurrently with the explain hop (speculative, gated by `looksLikeQuestion`); and
> the two Sonnet hops overlap, with the speculative answer buffered until hop 1
> confirms `is_question` (aborted otherwise). The answer is now **plain text** (was
> JSON) so it can stream. Verified via `tsc -b`, a runtime smoke through the real
> gateway, and standalone test typecheck. #4–#7 remain open.
>
> **Update (2026-06-06): #4 is now SHIPPED behind a "Fast answers" settings toggle.**
> A per-request preference (Settings → Performance; rides each explain/ask frame like
> `user_sources`) makes the web search run at Tavily `search_depth:'fast'`, fetch
> **2** sources instead of 3, and abort after **3.5 s** instead of 9 s — so a slow
> lookup degrades to model/user-source grounding rather than holding up the reply.
> Off by default ⇒ search args are byte-for-byte the originals (`'basic'`, 3 sources,
> 9 s). The `searchDepth` union now includes `'fast'|'ultra-fast'` and is overridable
> per call (`WebSearchOptions`). A second toggle (Providers → Web search) turns the
> web lookup **off** entirely for the session (no Tavily call; answers lean on the
> model + the user's own connected sources). Verified via per-package `tsc` + a
> `tsx --jitless` smoke (research depth/timeout/maxResults, explain+follow-up fast
> wiring, and the web-search-off path). #5–#7 remain open.

> Scope: the **on-demand answering path** only — `explainSentence` and
> `answerFollowup` in `packages/intel-worker/src/explain.ts`, wired by
> `packages/server/src/session.ts` and relayed by `packages/server/src/index.ts`.
> The background enrichment/extract workers are **not** on this path and are out of
> scope.
>
> Goal: reduce **end-to-end** and **perceived** latency **without** sacrificing
> answer quality. Every technique below was fact-checked against primary Anthropic
> and Tavily docs (see Sources); claims that failed verification are listed under
> "Refuted / do not rely on".

---

## 1. TL;DR — ranked recommendations

| # | Change | Type of latency | Expected impact | Quality risk | Effort |
|---|--------|-----------------|-----------------|--------------|--------|
| 1 | **Stream the answer/explanation token-by-token over the WS** (`stream:true` → relay `text_delta`) | Perceived (TTFT) | First text in **~0.3–1 s** instead of after the whole 3-hop chain | **None** (same tokens, same order) | Medium |
| 2 | **Speculative parallel search**: start Tavily concurrently with the explain call, using the sentence as the query | End-to-end | Removes the **search hop (~0.5–2 s) from the critical path** on questions | Low (handled by fallback) | Medium |
| 3 | **Parallelize the two Sonnet hops** in `explainSentence` (the answer call doesn't depend on the explain call) | End-to-end | Critical path drops from `explain + search + answer` to `max(explain, search + answer)` | None (already independent) | Medium |
| 4 | ✅ **Tavily `search_depth: 'fast'`** instead of `'basic'` *(shipped behind the "Fast answers" toggle)* | End-to-end | Search → **sub-second**, same 1 credit | Low | Trivial |
| 5 | **Route the cheap classify/query-extraction to Haiku 4.5**, keep synthesis on Sonnet 4.6 | End-to-end | Haiku is Anthropic's fastest model; saves on the cheap hop | Medium (validate) | Medium |
| 6 | **Prompt caching** — *conditional* here (see §5.6); fix the currently-inert cache | Mostly cost; some TTFT | Limited for this app's per-query context | None | Low–Medium |
| 7 | **Trim prompt/output tokens** (plain-text streamed answer, tighter `max_tokens`) | End-to-end (minor) | Small | Low | Low |

**Do #1 + #4 first** (highest impact-to-risk), then **#2 + #3** (the structural
re-shape), then evaluate #5/#6/#7.

---

## 2. Current latency anatomy

### `explainSentence` (sentence click → explanation, and answer if it's a question)
```
LLM #1 (Sonnet, enrich)            ── explanation + breakdown + is_question + search_query
        │   estOutputTokens 400, max_tokens forced to 1024
        ▼  (only if is_question)
Tavily search (search_depth 'basic', max_results 3)   ── must wait for search_query
        ▼
LLM #2 (Sonnet, enrich)            ── synthesize grounded answer
        │   estOutputTokens 200, max_tokens forced to 1024
        ▼
result buffered → ONE WebSocket frame   ── browser shows "Explaining…" the whole time
```
For a question this is **three serial network hops**, ~3–7 s, and the user sees
nothing until the end.

### `answerFollowup` (typed follow-up)
```
Tavily search ('basic', 3) → LLM (Sonnet, enrich, estOutputTokens 250) → buffered → 1 WS frame
```
Two serial hops; synthesis must follow the search (it grounds in the sources).

### Key facts from the code
- `provider-anthropic.ts`: 25 s request timeout, `maxRetries:1`, **no streaming**.
  System preamble (~60 tokens) is sent with `cache_control` — but see §5.6, it's
  **below the cache minimum so it does nothing**.
- `session.ts`: 30 s `ONDEMAND_TIMEOUT_MS` backstop; `TENANT_CEILING_USD=5`.
- `research/index.ts`: Tavily `search_depth:'basic'`, 9 s abort, `max_results` 3–4.
- `index.ts`: result delivered as a single `{type:'explanation'|'answer'}` frame —
  the WS plumbing for incremental frames does not exist yet.
- **`buildAnswerPrompt` uses only `sentence + sources`, NOT the explanation** — so
  LLM #2 is *independent* of LLM #1. This is what makes #3 (parallelize) safe.
- The BYO context block is **re-selected per query** (top-k BM25 in `sources.js`,
  ≤12 chunks / ≤24 KB), so it is **not a stable prefix** — important for #6.

---

## 3. The single biggest re-shape (combines #1 #2 #3)

Today (question case): `explain → search → answer → render`, serial, nothing shown
until done.

Proposed:
```
            ┌─ LLM #1 explain+breakdown (Sonnet)  ──stream──▶ browser (explanation appears live)
 click ──┬──┤
         │  └─ Tavily 'fast' search (heuristic query = the sentence)   ┐
         │       gated by the existing looksLikeQuestion() heuristic   │
         │                                                             ▼
         └──────────────────────────────────────▶ LLM #2 answer (Sonnet) ──stream──▶ browser
```
- LLM #1 and the search run **concurrently** (both kick off on the click).
- The answer call (#2) needs only the **search results**, not #1's output, so it
  starts as soon as the search returns.
- Both LLM calls **stream** to the browser, so the explanation renders almost
  immediately and the answer streams in right after the search.
- Critical path: `max( LLM#1 , search + LLM#2 )` instead of
  `LLM#1 + search + LLM#2`. On a typical question that's roughly a **40–55 %**
  end-to-end reduction, plus the perceived-latency win from streaming.

Correctness handling (the only real subtlety):
- Gate the speculative search with the existing `looksLikeQuestion()` (trailing `?`
  or interrogative lead) so non-questions don't waste a search.
- The speculative query is the raw sentence; verified research puts the
  first-step query "hit rate" at **~73 %** vs. a reasoned query — good enough that
  the prefetched results almost always ground the answer.
- If LLM #1 comes back `is_question:false`, **discard** the speculative results and
  don't run LLM #2 (same as today's behaviour).
- Worst case (mismatch / not-a-question) collapses to **today's latency** — never
  worse.

---

## 4. Streaming detail (#1) — the highest-value, zero-quality-risk change

**Verified (3-0, Anthropic docs):** streaming reduces **perceived** latency
(time-to-first-token), not total generation time. Set `stream: true`; the response
is an SSE event flow:
`message_start → (content_block_start → content_block_delta* → content_block_stop) → message_delta → message_stop` with `ping` events interspersed. Forward every
`content_block_delta` whose `delta.type === 'text_delta'` to the browser.

Implementation touchpoints:
- `provider-anthropic.ts`: add a streaming method using the SDK
  (`client.messages.stream(...)` / `for await (const event of ...)`), emit
  `delta.text` via a callback.
- `LlmGateway.invoke`: add a streaming variant (or an `onDelta` callback) that
  still records usage from the final `message_delta`/`message_stop` for the
  `CostMeter`.
- `session.ts` `explain`/`ask`: thread an `onDelta` through to the engine.
- `index.ts`: add incremental WS frames, e.g.
  `{type:'answer_delta', ask_id, text}` … then a final
  `{type:'answer', ask_id, answer, sources, state}`.
- `client.js`: append deltas into the answer/explanation node as they arrive; the
  final frame reconciles (sources, degraded state).

**Quality risk: none** — identical tokens in identical order. The only care:
- discriminate `text_delta` from `input_json_delta`/`thinking_delta`;
- **streaming and JSON-wrapped output fight each other** — see §5.7. For the
  user-facing **answer**, switch to **plain-text** output so the streamed tokens
  render directly; keep JSON only for the structured `breakdown` metadata.

Perceived-latency thresholds (Nielsen Norman Group): ~0.1 s feels instant, ~1 s
keeps flow, ~10 s loses attention. Streaming moves the user from "wait 3–7 s for
anything" to "text within ~1 s."

---

## 5. Each lever, with quality risk + mitigation

### 5.4 Tavily `search_depth: 'fast'` (#4) — easy, safe
**Verified (3-0, Tavily docs):** `search_depth` has four tiers — `basic` (default,
balanced, 1 credit), `advanced` (highest relevance, **higher latency**, 2 credits),
`fast` (lower latency, good relevance, 1 credit), `ultra-fast` (minimizes latency,
1 credit). `fast`/`ultra-fast` are designed for **sub-second** interactive use.
`max_results` default 5 (range 0-20).

- **Action:** change `search_depth` default from `'basic'` to `'fast'` in
  `research/index.ts`; keep `max_results` at 3–4 (already low).
- **Latency:** search → sub-second (an independent 2026 benchmark measured
  `basic` ~998 ms average vs `ultra-fast` ~210 ms).
- **Quality risk:** `fast` keeps "good relevance"; `ultra-fast` trades relevance
  for speed and drops some safety filtering. **Use `fast`, not `ultra-fast`**, for
  grounded QA. Reserve `advanced` for a future "deep dive" mode.
- **Caveat to confirm:** `fast`/`ultra-fast` are newer tiers — verify your Tavily
  plan exposes them; the adapter currently only types `'basic'|'advanced'`.

### 5.5 Model routing — Haiku for the cheap hop (#5) — medium, validate
**Verified (3-0):** Anthropic names **Claude Haiku 4.5 the fastest model** and
calls model choice "one of the most straightforward ways to reduce latency."
**Refuted (do not cite):** every *specific* Haiku-vs-Sonnet latency/accuracy number
from blogs (e.g. "80-120 ms vs 150-200 ms", "2-3× faster", "accuracy gap 2-3 pp")
**failed verification**. Only the *direction* (Haiku faster, Sonnet higher quality)
is reliable.

- **Where it helps here:** if you split classification/query-extraction out of the
  Sonnet explain call, run that thin classify step on **Haiku**. Keep the
  user-facing **explanation, breakdown, and answer synthesis on Sonnet 4.6.**
- **Important nuance:** in the *current* design, LLM #1 also produces the
  user-facing explanation+breakdown, so it can't simply be downgraded to Haiku
  wholesale without a quality hit. The cleaner path is #2/#3 (speculative search +
  parallel hops), which makes a separate classify call largely unnecessary — the
  local `looksLikeQuestion()` heuristic already gates the speculative search.
- **Mitigation if you do route to Haiku:** benchmark Haiku's generated search
  queries on a sample set; fall back to Sonnet when confidence is low. Note Haiku's
  cache minimum is **4,096 tokens** (4× Sonnet's 1,024) — matters for #6.

### 5.6 Prompt caching (#6) — mostly a **cost** lever here, not latency
**Verified (3-0, Anthropic docs + launch blog):** caching reduces **latency in
addition to cost** — up to ~85 % latency / ~90 % cost on **long** prompts
(a 100K-token cached prompt cut TTFT 11.5 s → 2.4 s). Cache **read** = 0.1× input,
**write** = 1.25× (5-min TTL) / 2× (1-h TTL); 5-min and 1-h behave **identically
for latency**. **Minimum cacheable prefix: 1,024 tokens (Sonnet/Opus 4.x),
4,096 tokens (Haiku 4.5).** Up to 4 cache breakpoints per request *(the "4" was
flagged by the research as worth re-confirming against live docs).*

**Why it's only conditional for this app — two real blockers:**
1. **The current cache is inert.** The cached system preamble is ~60 tokens — far
   **below the 1,024-token minimum**, so `cache_control` on it is **silently
   ignored**. It is doing nothing today.
2. **The reused context is not a stable prefix.** `sources.js` selects a *different*
   top-k set of chunks **per query** (per sentence/question), so the big block
   changes every request → **no cache hit** on it. The 79–85 % figures are also
   Claude-3.x-era at 100K tokens; at this app's ~6–16K-token scale on Sonnet 4.6
   the absolute saving is smaller and must be measured.

**To actually get a caching benefit, you'd restructure so a stable, ≥1,024-token
prefix is reused across consecutive requests in a session**, e.g.:
- Cache the **full transcript + fixed instruction scaffold** for follow-ups within
  one session (it's append-only → stable prefix across the Q→A thread), **or**
- Offer a "pin these sources for the session" mode that ships the *same* context set
  each request (a stable cacheable block) instead of re-selecting top-k.
- Order the prompt **stable-prefix-first** (system + instructions + pinned context),
  per-request text (the sentence/question) **last**, with the cache breakpoint after
  the stable part.

**Bottom line:** valuable for **cost** and for sessions with a large pinned context;
**low priority as a pure latency lever** for the current per-query design. Quality
risk: **none** (identical bytes reused).

### 5.7 Prompt/output token reduction (#7) — minor (low confidence)
This sub-area had **no dedicated verified claim** (inferred from the TTFT /
generation-time model). Latency scales with tokens generated, so:
- **Stream a plain-text answer** instead of `{"answer":"..."}` — removes JSON
  scaffolding tokens *and* unblocks useful streaming (§4). Keep JSON only for the
  `breakdown`.
- `max_tokens` is currently forced to ≥1024 for Sonnet via
  `Math.max(est, DEFAULT_MAX_TOKENS)`. **Raising `max_tokens` does not slow
  generation** (you only pay for tokens actually produced), so this is **not** a
  real latency lever — don't expect a win from lowering it, beyond a safety cap.
- Tighten the verbose prompt scaffolds in `explain.ts` modestly (input tokens →
  TTFT), but don't sacrifice the grounding instructions that protect quality.
- **Quality risk:** over-aggressive `max_tokens` caps truncate grounded answers;
  over-terse output drops nuance. Set caps from a measured p95 of needed length.

---

## 6. Suggested phased rollout

1. **Phase A (fast, safe):** Tavily `'fast'` (#4) + stream the answer as plain text
   (#1, answer first — it's where users wait most). Measure TTFT before/after.
2. **Phase B (structural):** speculative parallel search (#2) + parallelize the two
   Sonnet hops (#3), gated by `looksLikeQuestion()`, with mismatch fallback. Stream
   the explanation too.
3. **Phase C (evaluate):** Haiku routing for any remaining classify step (#5, with
   an eval set) and prompt caching **only if** you add a session-pinned-context /
   stable-prefix mode (#6).

**How to measure (so "doesn't sacrifice quality" is provable):**
- Instrument TTFT and end-to-end ms per hop (the gateway already has the call
  boundaries).
- Keep a small fixed set of sentences/questions + expected sources; diff answers
  and citations before/after each change to confirm grounding/quality is unchanged.
- Watch `CostMeter.spentUsd()` — speculative search and an extra Haiku hop add
  cost; the per-tenant ceiling ($5) already backstops it.

---

## 7. Refuted / do not rely on
- ❌ "Haiku 4.5 TTFT 80-120 ms vs Sonnet 150-200 ms / 2-3× faster" — **0-3, refuted.**
- ❌ "Haiku-vs-Sonnet classification accuracy gap only 2-3 pp" — **0-3, refuted.**
- ❌ "Sonnet 4.6 outscores Haiku on every benchmark (specific OSWorld/GPQA numbers)"
  — **1-2, not supported.**
- ⚠️ Speculative-execution "1.65× end-to-end speedup" — from a **single
  non-peer-reviewed preprint on self-hosted open models**; the *principle* and the
  **~73 % first-step query hit-rate** transfer, the **multiplier does not**. Expect
  "one eliminated serial hop," not a guaranteed 1.65×.
- ⚠️ Prompt-caching "79 %/85 %" — Claude-3.x-era, 100K-token, TTFT-only best case.
  Re-measure at this app's ~6–16K-token scale.
- ⚠️ Max cache breakpoints "= 4" — confirm against live Anthropic docs.

---

## 8. Sources (primary unless noted)
- Anthropic — Reduce latency: https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/reduce-latency
- Anthropic — Streaming Messages: https://platform.claude.com/docs/en/build-with-claude/streaming
- Anthropic — Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic — Pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic — Prompt caching launch (benchmarks): https://www.anthropic.com/news/prompt-caching
- Anthropic — Glossary (TTFT): https://platform.claude.com/docs/en/about-claude/glossary
- Tavily — Search API reference (search_depth, max_results): https://docs.tavily.com/documentation/api-reference/endpoint/search
- Tavily — "Fastest web search" (fast/ultra-fast): https://www.tavily.com/blog/how-we-built-the-fastest-web-search-in-the-world
- Tavily — API credits: https://docs.tavily.com/documentation/api-credits
- Speculative actions preprint (caveated): https://arxiv.org/pdf/2511.20048
- NN/g — Response-time limits: https://www.nngroup.com/articles/response-times-3-important-limits

_Research method: 5-angle fan-out web search → 22 sources fetched → 97 claims →
25 adversarially verified (3-vote) → 22 confirmed, 3 killed. Generated 2026-06-05._
