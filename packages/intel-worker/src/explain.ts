/**
 * Lane D — the sentence "explain engine" (P2-B). Given ONE final transcript
 * sentence, produce a `SentenceExplanation`: a plain-language meaning, a
 * breakdown of specific key words, and — when the sentence is a question — a
 * short answer grounded in `WebSearchProvider` results (INV-1/2: every web claim
 * carries a URL citation so F03 can show provenance).
 *
 * Runs on demand (the F03 user clicks a sentence), not auto per term. Two LLM
 * hops at most: an `enrich` call to explain + classify, then — only for questions
 * with sources — a second `enrich` call to synthesize a grounded answer. Either
 * hop degrading (cost ceiling, non-JSON stub reply) falls back to a structured,
 * heuristic result so the UI always renders the shape (`state:'degraded'`).
 *
 * GROUNDING posture: the answer prompt pins the model to the retrieved sources
 * and asks for "unknown" when they don't contain the answer — no answer is
 * synthesized without sources, so questions never hallucinate from parametric
 * memory alone.
 */
import type {
  ExplanationSource,
  FollowupAnswer,
  SentenceExplanation,
  UserSource,
  WordBreakdown,
} from '@aizen/contracts';
import { isStubReply, type LlmGateway } from '@aizen/llm-gateway';
import type { WebSearchOptions, WebSearchProvider, WebSource } from '@aizen/research';

/**
 * Streaming hooks (latency lever #1). Both engines emit the grounded ANSWER as it
 * is produced via `onAnswerDelta` (plain-text fragments, in order); `explainSentence`
 * also paints the explanation+breakdown the moment hop 1 is parsed (`onExplanation`),
 * before the answer has finished — so the UI fills progressively instead of waiting
 * for the whole chain. All hooks are optional: omit them and the engines behave
 * exactly as the buffered, single-result callers expect.
 */
export interface AnswerStreamHooks {
  /** Each incremental fragment of the grounded answer (real provider only). */
  onAnswerDelta?: (text: string) => void;
}
export interface ExplainHooks extends AnswerStreamHooks {
  /** Hop-1 result (explanation + breakdown + classification), before the answer. */
  onExplanation?: (partial: {
    segment_id: string;
    sentence: string;
    explanation: string;
    breakdown: WordBreakdown[];
    is_question: boolean;
  }) => void;
}

/** The minimal identity + text the engine needs from a final segment. */
export interface ExplainInput {
  segment_id: string;
  session_id: string;
  tenant_id: string;
  text: string;
}

export interface ExplainOptions {
  /** Web search for grounding question answers. Omit ⇒ questions get no answer. */
  research?: WebSearchProvider;
  /** Max web sources to attach. Default 3 (2 in `fast` mode). */
  maxSources?: number;
  /**
   * "Answer as fast as possible" mode (settings toggle; PERFORMANCE_RESEARCH.md
   * §4/§5.4). When on, the web search runs at Tavily's sub-second `'fast'` depth,
   * fetches fewer sources, and bails sooner if it stalls (degrading to model/user-
   * source grounding) — so the reply is never held up by a slow lookup. The
   * already-on streaming + speculative-parallel + parallel-hop levers (#1/#2/#3)
   * apply regardless; this trades a little search breadth for latency on top. Off
   * ⇒ every search arg is byte-for-byte the original (depth 'basic', 3 sources).
   */
  fast?: boolean;
  /**
   * User-provided context (F2): pasted notes / URLs-with-comments the asker handed
   * the AI. Folded into the answer prompt as authoritative context and emitted as
   * `type:'user'` citations. Their presence is enough to answer a question even
   * with NO web search (no Tavily key) — that's the whole point of BYO sources.
   */
  userSources?: UserSource[];
  /**
   * Recent FINAL transcript lines from the live session (oldest→newest), the
   * sentence's surrounding conversation. Folded in so a sentence that a long pause
   * split across lines is read together with its neighbours (the explanation,
   * breakdown, and `is_question` classification all see the context), and so a
   * fragmentary question resolves what it refers to. It is DISAMBIGUATION context
   * only for the answer — the grounded answer is still synthesized solely from web /
   * user sources, never from the transcript, so questions never hallucinate. Absent
   * ⇒ both prompts are byte-for-byte the no-context originals.
   */
  transcript?: string[];
}

/** How many recent transcript lines to fold in as context (backstop; client caps too). */
const EXPLAIN_CONTEXT_LINES = 12;

/** Default web sources to attach, normal vs. "fast" mode (fewer ⇒ quicker synthesis). */
const DEFAULT_MAX_SOURCES = 3;
const FAST_MAX_SOURCES = 2;
/** Tighter Tavily abort in "fast" mode: bail and degrade rather than hold up the reply. */
const FAST_SEARCH_TIMEOUT_MS = 3500;

/**
 * Per-call web-search options for this request. In `fast` mode they select Tavily's
 * sub-second `'fast'` depth and a tighter abort; otherwise the object is just
 * `{ maxResults }` — byte-for-byte the original call. `maxResults` is resolved by the
 * caller (so an explicit `opts.maxSources` always wins over the mode default).
 */
function searchOptionsFor(fast: boolean, maxResults: number): WebSearchOptions {
  return fast
    ? { maxResults, searchDepth: 'fast', timeoutMs: FAST_SEARCH_TIMEOUT_MS }
    : { maxResults };
}

/** What the explain call is asked to return; parsed leniently. */
interface ParsedExplain {
  explanation: string;
  breakdown: WordBreakdown[];
  is_question: boolean;
  search_query: string;
}

/**
 * Explain one sentence. Always resolves to a `SentenceExplanation` — never throws
 * for a degraded gateway or a question with no sources (best-effort, UI-safe).
 */
export async function explainSentence(
  input: ExplainInput,
  gateway: LlmGateway,
  opts: ExplainOptions = {},
  hooks: ExplainHooks = {},
): Promise<SentenceExplanation> {
  const sentence = input.text.trim();
  const userSources = opts.userSources ?? [];
  const fast = opts.fast ?? false;
  const maxResults = opts.maxSources ?? (fast ? FAST_MAX_SOURCES : DEFAULT_MAX_SOURCES);
  const searchOpts = searchOptionsFor(fast, maxResults);
  // Recent conversation around this sentence (live transcript). Trimmed, de-blanked,
  // and capped so one frame can't carry an unbounded prompt. Empty ⇒ no context block.
  const transcript = (opts.transcript ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(-EXPLAIN_CONTEXT_LINES);
  let degraded = false;

  // ── (#2 speculative search) ────────────────────────────────────────────────
  // Kick the web search off CONCURRENTLY with the explain call, using the sentence
  // itself as the query (a heuristic query matches a reasoned one ~73% of the time
  // at the first step — see PERFORMANCE_RESEARCH.md). Gated by the cheap local
  // `looksLikeQuestion` so a plain statement never spends a search/credit. The
  // model's own `is_question` (hop 1) stays authoritative for whether we SHOW an
  // answer; this only takes the search OFF the critical path. Never rejects → [].
  const heuristicQuestion = looksLikeQuestion(sentence);
  const speculativeSearch: Promise<WebSource[]> | null =
    heuristicQuestion && opts.research
      ? opts.research
          .search(sentence, searchOpts)
          .then((r) => r.sources.filter((s) => s.url))
          .catch(() => [])
      : null;

  // ── (#1 stream + #3 parallel answer) ───────────────────────────────────────
  // The answer hop depends ONLY on the sources (not on hop 1's output — see
  // `buildAnswerPrompt`), so it runs concurrently with the explain call, starting
  // the moment sources are known. Its streamed deltas are BUFFERED until hop 1
  // confirms `is_question`; then flushed and forwarded live. If hop 1 says "not a
  // question", the stream is ABORTED and the buffer dropped — a non-question never
  // shows (or pays to finish) an answer. So the two Sonnet hops overlap with no
  // risk of surfacing an answer we'd have to retract.
  let gateOpen = false;
  const deltaBuffer: string[] = [];
  const forwardDelta = (text: string): void => {
    if (!hooks.onAnswerDelta) return;
    if (gateOpen) hooks.onAnswerDelta(text);
    else deltaBuffer.push(text);
  };
  const openGate = (): void => {
    gateOpen = true;
    if (hooks.onAnswerDelta && deltaBuffer.length) {
      hooks.onAnswerDelta(deltaBuffer.join(''));
      deltaBuffer.length = 0;
    }
  };

  const answerAbort = new AbortController();
  // Resolves to the synthesized answer + the web sources it used (null answer when
  // there's nothing to ground, or the gateway degraded). Always resolves.
  const speculativeAnswer:
    | Promise<{ webSources: WebSource[]; answer: string | null; degraded: boolean }>
    | null = heuristicQuestion
    ? (speculativeSearch ?? Promise.resolve<WebSource[]>([])).then(async (webSources) => {
        // No grounding at all → no answer (matches the web-OR-user rule below).
        if (webSources.length === 0 && userSources.length === 0) {
          return { webSources, answer: null, degraded: false };
        }
        const ans = await gateway.invokeStream(
          {
            kind: 'enrich',
            tenantId: input.tenant_id,
            prompt: buildAnswerPrompt(sentence, webSources, userSources, transcript),
            estOutputTokens: 200,
          },
          { onDelta: forwardDelta, signal: answerAbort.signal },
        );
        if (!ans.ok || isStubReply(ans.text)) return { webSources, answer: null, degraded: true };
        return { webSources, answer: cleanAnswer(ans.text), degraded: false };
      })
    : null;

  // Hop 1 — explain + break down + classify (non-streamed JSON; the structure is the
  // point). Folds in the asker's own connected sources so the EXPLANATION itself is
  // grounded in their context, not only the answer.
  const res = await gateway.invoke({
    kind: 'enrich',
    tenantId: input.tenant_id,
    prompt: buildExplainPrompt(sentence, userSources, transcript),
    estOutputTokens: 400,
  });
  const candidate = res.ok ? parseExplain(res.text, sentence) : null;
  let parsed: ParsedExplain;
  if (candidate && candidate.explanation) {
    parsed = candidate;
  } else {
    degraded = true;
    parsed = fallbackExplain(sentence, res.ok ? res.text : '');
  }

  // Paint the explanation now — the answer (if any) streams in next.
  hooks.onExplanation?.({
    segment_id: input.segment_id,
    sentence,
    explanation: parsed.explanation,
    breakdown: parsed.breakdown,
    is_question: parsed.is_question,
  });

  let answer: string | null = null;
  let sources: SentenceExplanation['sources'] = [];

  if (parsed.is_question) {
    if (speculativeAnswer) {
      // Heuristic agreed → the answer is already in flight. Open the gate (flush any
      // buffered deltas + forward the rest live), then take its final text.
      openGate();
      const r = await speculativeAnswer;
      sources = buildSources(input.segment_id, r.webSources, userSources, 'web');
      answer = r.answer;
      if (r.degraded) degraded = true;
    } else {
      // Heuristic MISSED but the model says it's a question → fall back to the
      // sequential path (search with the model's query, then a streamed answer).
      // Worst case = the original latency, never worse.
      gateOpen = true; // nothing buffered; forward straight through
      let webSources: WebSource[] = [];
      if (opts.research) {
        const query = parsed.search_query.trim() || sentence;
        try {
          const r = await opts.research.search(query, searchOpts);
          webSources = r.sources.filter((s) => s.url);
        } catch {
          webSources = [];
        }
      }
      sources = buildSources(input.segment_id, webSources, userSources, 'web');
      if (webSources.length > 0 || userSources.length > 0) {
        const ans = await gateway.invokeStream(
          {
            kind: 'enrich',
            tenantId: input.tenant_id,
            prompt: buildAnswerPrompt(sentence, webSources, userSources, transcript),
            estOutputTokens: 200,
          },
          { onDelta: forwardDelta },
        );
        if (!ans.ok || isStubReply(ans.text)) degraded = true;
        else answer = cleanAnswer(ans.text);
      }
    }
  } else if (speculativeAnswer) {
    // The model says this isn't a question → drop the speculative answer (its deltas
    // were buffered, never shown) and stop paying for it.
    answerAbort.abort();
    void speculativeAnswer.catch(() => undefined);
  }

  return {
    id: `se_${input.segment_id}`,
    session_id: input.session_id,
    tenant_id: input.tenant_id,
    segment_id: input.segment_id,
    sentence,
    explanation: parsed.explanation,
    breakdown: parsed.breakdown,
    is_question: parsed.is_question,
    answer,
    sources,
    state: degraded ? 'degraded' : 'ok',
  };
}

// ---------------------------------------------------------------------------
// F1 — answer a typed follow-up question about an already-explained sentence
// ---------------------------------------------------------------------------

/** The conversation context a follow-up is answered against. */
export interface FollowupContext {
  /** The sentence the follow-up is about (the selected/most-recent final line). */
  sentence: string;
  /** Recent FINAL transcript lines, oldest→newest, for conversational grounding. */
  transcript: string[];
}

/** Identity + the typed question + the conversation context for a follow-up. */
export interface FollowupInput {
  segment_id: string;
  session_id: string;
  tenant_id: string;
  question: string;
  context: FollowupContext;
}

export interface FollowupOptions {
  /** Web search for grounding outside facts with citations. Omit ⇒ context-only. */
  research?: WebSearchProvider;
  /** Max web sources to attach. Default 3 (2 in `fast` mode). */
  maxSources?: number;
  /**
   * User-provided context (F2), folded into the follow-up prompt as authoritative
   * context and emitted as `type:'user'` citations — alongside any web sources.
   */
  userSources?: UserSource[];
  /** "Answer as fast as possible" mode — see `ExplainOptions.fast`. */
  fast?: boolean;
}

/**
 * Answer a user-typed follow-up about a sentence that was just explained. Unlike
 * `explainSentence` (which grounds an answer ONLY in fresh web search and never
 * sees the transcript), this grounds the answer in BOTH the supplied conversation
 * `context` AND web sources — so a context-dependent question ("what did he mean
 * by that?") gets a real answer instead of `null`, while outside-fact questions
 * still carry web citations (INV-1/2).
 *
 * One web search (no LLM cost) + at most ONE `enrich` hop — same budget posture as
 * `explainSentence`, and it always resolves: a stubbed/cost-capped gateway, a
 * non-JSON reply, or an "unknown" verdict all fall back to `state:'degraded'` with
 * a null answer. Never throws, so the UI button never wedges.
 */
export async function answerFollowup(
  input: FollowupInput,
  gateway: LlmGateway,
  opts: FollowupOptions = {},
  hooks: AnswerStreamHooks = {},
): Promise<FollowupAnswer> {
  const question = input.question.trim();
  const sentence = (input.context.sentence ?? '').trim();
  const transcript = (input.context.transcript ?? []).map((t) => t.trim()).filter(Boolean);
  const userSources = opts.userSources ?? [];
  let degraded = false;

  // 1) Best-effort web search to ground outside facts with citations. The query
  //    blends the question with the sentence it's about so context-anchored asks
  //    ("how does that compare to X?") retrieve relevant pages. (A follow-up is
  //    always a question, and synthesis must SEE the sources, so — unlike explain —
  //    the search stays ahead of the LLM hop; the latency win here is streaming.)
  let webSources: WebSource[] = [];
  if (opts.research) {
    const fast = opts.fast ?? false;
    const maxResults = opts.maxSources ?? (fast ? FAST_MAX_SOURCES : DEFAULT_MAX_SOURCES);
    const query = buildFollowupQuery(question, sentence);
    try {
      const r = await opts.research.search(query, searchOptionsFor(fast, maxResults));
      webSources = r.sources.filter((s) => s.url);
    } catch {
      webSources = [];
    }
  }
  const sources = buildSources(input.segment_id, webSources, userSources, 'fu');

  // 2) Synthesize from conversation context + web + user sources (one enrich hop),
  //    STREAMED to the UI (#1). The CostMeter still enforces the per-tenant ceiling;
  //    a refusal (cost cap) or the stub's marker reply → degraded, never throws.
  let answer: string | null = null;
  const res = await gateway.invokeStream(
    {
      kind: 'enrich',
      tenantId: input.tenant_id,
      prompt: buildFollowupPrompt(question, sentence, transcript, webSources, userSources),
      estOutputTokens: 250,
    },
    { onDelta: hooks.onAnswerDelta },
  );
  if (!res.ok || isStubReply(res.text)) {
    degraded = true;
  } else {
    answer = cleanAnswer(res.text);
  }

  return {
    id: `fu_${input.segment_id}`,
    session_id: input.session_id,
    tenant_id: input.tenant_id,
    segment_id: input.segment_id,
    question,
    answer,
    sources,
    state: degraded ? 'degraded' : 'ok',
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
/**
 * Render the surrounding live-transcript lines as a prompt block, or '' when there
 * are none (so the no-context prompt is byte-for-byte the original). `lead` frames
 * what the model should DO with the lines — disambiguate (explain hop) vs. only
 * resolve-the-reference (answer hop). Always opens with "Recent conversation for
 * context" so both prompts share one stable, testable marker.
 */
function transcriptBlock(transcript: string[], lead: string): string {
  if (!transcript.length) return '';
  return (
    `Recent conversation for context (most recent last). ${lead}\n` +
    `${transcript.map((l) => `- ${l}`).join('\n')}\n\n`
  );
}

function buildExplainPrompt(
  sentence: string,
  userSources: UserSource[] = [],
  transcript: string[] = [],
): string {
  // When the asker has connected their own notes/files (e.g. an Obsidian vault),
  // fold the relevant ones in so the EXPLANATION is grounded in their context.
  // Appended ONLY when present, so the no-sources prompt is byte-for-byte unchanged.
  const context = userSources.length
    ? `The person has connected their own notes/files (e.g. an Obsidian vault). Use ` +
      `them to inform the explanation when relevant to the sentence — prefer their ` +
      `terminology and specifics, and do not invent details that are not in them.\n` +
      `Their context:\n${userSourcesBlock(userSources)}\n\n`
    : '';
  // Live transcript around the sentence: a long pause can split one thought across
  // lines, so read the sentence together with its neighbours — but explain THAT
  // sentence, not the whole conversation. Appended only when present.
  const convo = transcriptBlock(
    transcript,
    `The sentence above may be a fragment of a longer thought that a pause split ` +
      `across lines — read it together with these lines, but explain only THAT sentence:`,
  );
  return (
    `You help someone understand a sentence from a live conversation.\n\n` +
    `Sentence: "${sentence}"\n\n` +
    convo +
    context +
    `Reply with ONLY a JSON object, no prose:\n` +
    `{"explanation": "<one or two plain-language sentences explaining what the ` +
    `whole sentence means>", ` +
    `"breakdown": [{"word": "<a key or difficult word/phrase from the sentence>", ` +
    `"meaning": "<short plain meaning in this context>"}], ` +
    `"is_question": <true if the sentence asks a question, else false>, ` +
    `"search_query": "<if is_question, a concise web query that would answer it; else \\"\\">"}\n` +
    `Include up to 6 breakdown entries — only genuinely notable words.`
  );
}

function buildAnswerPrompt(
  sentence: string,
  sources: WebSource[],
  userSources: UserSource[] = [],
  transcript: string[] = [],
): string {
  const block = sources
    .map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet.slice(0, 300)}`)
    .join('\n');
  // Live transcript as DISAMBIGUATION ONLY: it lets the model resolve what a
  // fragmentary/elliptical question refers to (a pause may have split it from its
  // setup line), but the answer itself must still come solely from the web/user
  // sources — never from the conversation — so questions can't hallucinate from
  // parametric memory. Appended only when present (no-context prompt unchanged).
  const convo = transcriptBlock(
    transcript,
    `The question may be a fragment split from a longer thought by a pause; use ` +
      `these lines ONLY to understand what it refers to, not as a source for the answer:`,
  );
  // No user sources → byte-for-byte the original web-only grounding prompt
  // (so behavior with no BYO sources is unchanged).
  // Plain-text output (not JSON) so the answer can stream token-by-token straight to
  // the UI (#1). "unknown" stays the no-answer sentinel; `cleanAnswer` strips stray
  // quotes/fences a model might still add.
  const reply =
    `Answer in plain text — a direct 1-3 sentence answer grounded in the sources, ` +
    `with no JSON, no preamble, and no surrounding quotes (or exactly "unknown").`;
  if (userSources.length === 0) {
    return (
      `A live conversation asked: "${sentence}"\n\n` +
      convo +
      `Use ONLY these web sources to answer. If they do not contain the answer, ` +
      `reply with exactly "unknown".\n\nSources:\n${block}\n\n` +
      reply
    );
  }
  const webPart = sources.length ? `Web sources:\n${block}\n\n` : '';
  return (
    `A live conversation asked: "${sentence}"\n\n` +
    convo +
    `Use ONLY the sources below — the web sources AND the context the user ` +
    `provided — to answer. If they do not contain the answer, reply with exactly ` +
    `"unknown".\n\n` +
    webPart +
    `Provided by the user (treat as authoritative context):\n${userSourcesBlock(userSources)}\n\n` +
    reply
  );
}

/** A web query that blends the follow-up question with the sentence it's about. */
function buildFollowupQuery(question: string, sentence: string): string {
  const q = question.trim();
  const s = sentence.trim();
  if (!s) return q;
  return `${q} (about: ${s})`;
}

function buildFollowupPrompt(
  question: string,
  sentence: string,
  transcript: string[],
  sources: WebSource[],
  userSources: UserSource[] = [],
): string {
  const convo = transcript.length
    ? transcript.map((l) => `- ${l}`).join('\n')
    : '(no prior transcript captured)';
  const block = sources.length
    ? sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet.slice(0, 300)}`).join('\n')
    : '(no web sources available)';
  // Appended only when present, so the no-user-sources prompt is unchanged.
  const userBlock = userSources.length
    ? `\n\nProvided by the user (treat as authoritative context):\n${userSourcesBlock(userSources)}`
    : '';
  return (
    `You are helping someone follow up on a live conversation they are listening to.\n\n` +
    `Conversation so far (most recent last):\n${convo}\n\n` +
    (sentence ? `They are asking specifically about this line: "${sentence}"\n\n` : '') +
    `Their typed follow-up question: "${question}"\n\n` +
    `Answer using the conversation context above AND the web sources below. ` +
    `For questions about what was said ("what did he mean?", "give me a simpler ` +
    `explanation"), rely on the conversation context. For outside facts, use the ` +
    `web sources and ground your claims in them. If you genuinely cannot answer ` +
    `from either, reply with exactly "unknown".\n\n` +
    `Web sources:\n${block}${userBlock}\n\n` +
    `Answer in plain text — a direct 1-4 sentence answer grounded in the ` +
    `context/sources, with no JSON, no preamble, and no surrounding quotes ` +
    `(or exactly "unknown").`
  );
}

/**
 * A user source as a citation. The citation `type` carries provenance from the
 * source's `origin` (F3 §4 polish): a local `file` or an `obsidian` note keep their
 * kind for the UI to icon/group; a pasted note (or no origin) is plain `type:'user'`.
 * url is included only when the user gave one (web-only requires it, INV-1/2).
 */
function userCitation(citationId: string, u: UserSource): ExplanationSource {
  const type: ExplanationSource['type'] =
    u.origin === 'file' ? 'file' : u.origin === 'obsidian' ? 'obsidian' : 'user';
  return {
    citation_id: citationId,
    type,
    ...(u.url ? { url: u.url } : {}),
    ...(u.title ? { title: u.title } : {}),
    snippet: (u.text ?? '').slice(0, 400),
    support_score: 0.5,
  };
}

/** Render user sources for a prompt block: "[1] Title (url): text…". */
function userSourcesBlock(userSources: UserSource[]): string {
  return userSources
    .map((u, i) => {
      const label = [u.title, u.url].filter(Boolean).join(' — ');
      const head = label ? `${label}: ` : '';
      return `[${i + 1}] ${head}${(u.text ?? '').slice(0, 600)}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Lenient parsing
// ---------------------------------------------------------------------------
function firstJsonObject(text: string): unknown | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function parseExplain(text: string, sentence: string): ParsedExplain {
  const obj = firstJsonObject(text) as Partial<ParsedExplain> | null;
  if (!obj || typeof obj.explanation !== 'string') {
    return { explanation: '', breakdown: [], is_question: false, search_query: '' };
  }
  const breakdown = Array.isArray(obj.breakdown)
    ? obj.breakdown
        .filter((b): b is WordBreakdown => !!b && typeof b.word === 'string')
        .map((b) => ({ word: String(b.word), meaning: String(b.meaning ?? '') }))
        .slice(0, 6)
    : [];
  return {
    explanation: obj.explanation.trim(),
    breakdown,
    is_question: typeof obj.is_question === 'boolean' ? obj.is_question : looksLikeQuestion(sentence),
    search_query: typeof obj.search_query === 'string' ? obj.search_query : '',
  };
}

/**
 * Normalize a streamed PLAIN-TEXT answer: trim, strip an accidental ```code fence```
 * or a single pair of surrounding quotes, and map the "unknown" sentinel (or empty)
 * to null. The stub's marker reply is caught earlier via `isStubReply`, so this only
 * ever sees real model text.
 */
function cleanAnswer(text: string): string | null {
  let t = (text ?? '').trim();
  const fenced = t.match(/^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) t = fenced[1]!.trim();
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  if (!t || t.toLowerCase() === 'unknown') return null;
  return t;
}

/**
 * Build the citation list for an answer: web sources first (each carries a URL +
 * snippet, INV-1/2), then the user's own sources. `webTag` keys the web citation id
 * ('web' for explain, 'fu' for a follow-up) so ids stay stable + distinct per surface.
 */
function buildSources(
  segmentId: string,
  webSources: WebSource[],
  userSources: UserSource[],
  webTag: 'web' | 'fu',
): ExplanationSource[] {
  return [
    ...webSources.map((s, i) => ({
      citation_id: `ct_${segmentId}_${webTag}_${i}`,
      type: 'web' as const,
      url: s.url,
      title: s.title,
      snippet: s.snippet.slice(0, 400),
      support_score: s.score ?? 0.5,
    })),
    ...userSources.map((u, i) => userCitation(`ct_${segmentId}_user_${i}`, u)),
  ];
}

/**
 * Degraded fallback (stub provider / cost ceiling): keep the model's raw text as
 * the explanation and build a deterministic key-word breakdown so the UI still
 * shows the feature's shape. Question detection falls back to the heuristic.
 */
function fallbackExplain(sentence: string, modelText: string): ParsedExplain {
  const explanation =
    modelText.trim() ||
    'Explanation unavailable — add an ANTHROPIC_API_KEY to .env for real explanations.';
  const breakdown = pickKeyWords(sentence).map((word) => ({
    word,
    meaning: '(definition unavailable in demo mode)',
  }));
  return {
    explanation,
    breakdown,
    is_question: looksLikeQuestion(sentence),
    search_query: sentence,
  };
}

/** Heuristic question detection: trailing '?' or a leading interrogative. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  return /^(who|what|when|where|why|how|which|whose|whom|is|are|am|was|were|do|does|did|can|could|should|would|will|shall|may|might|have|has|had)\b/.test(
    t,
  );
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'their', 'there', 'these', 'those', 'where', 'which',
  'while', 'would', 'could', 'should', 'being', 'doing', 'going', 'thing', 'think',
  'really', 'because', 'before', 'between', 'through', 'around', 'against',
]);

/** Pick up to 6 notable words: acronyms, or distinct words ≥5 chars, source order. */
export function pickKeyWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of text.match(/[A-Za-z][A-Za-z'-]*[A-Za-z]/g) ?? []) {
    const lower = tok.toLowerCase();
    const isAcronym = tok.length >= 2 && tok === tok.toUpperCase();
    if (!isAcronym && (tok.length < 5 || STOPWORDS.has(lower))) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(tok);
    if (out.length >= 6) break;
  }
  return out;
}
