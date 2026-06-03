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
import type { FollowupAnswer, SentenceExplanation, WordBreakdown } from '@aizen/contracts';
import type { LlmGateway } from '@aizen/llm-gateway';
import type { WebSearchProvider, WebSource } from '@aizen/research';

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
  /** Max web sources to attach. Default 3. */
  maxSources?: number;
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
): Promise<SentenceExplanation> {
  const sentence = input.text.trim();
  let degraded = false;

  // 1) Explain + break down + classify (Sonnet via routeTier('enrich')).
  const res = await gateway.invoke({
    kind: 'enrich',
    tenantId: input.tenant_id,
    prompt: buildExplainPrompt(sentence),
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

  // 2) Question? → ground a short answer in web sources (best-effort).
  let answer: string | null = null;
  let sources: SentenceExplanation['sources'] = [];
  if (parsed.is_question && opts.research) {
    const query = parsed.search_query.trim() || sentence;
    let webSources: WebSource[] = [];
    try {
      const r = await opts.research.search(query, { maxResults: opts.maxSources ?? 3 });
      webSources = r.sources.filter((s) => s.url);
    } catch {
      webSources = [];
    }

    if (webSources.length > 0) {
      sources = webSources.map((s, i) => ({
        citation_id: `ct_${input.segment_id}_web_${i}`,
        type: 'web' as const,
        url: s.url,
        title: s.title,
        snippet: s.snippet.slice(0, 400),
        support_score: s.score ?? 0.5,
      }));

      const ans = await gateway.invoke({
        kind: 'enrich',
        tenantId: input.tenant_id,
        prompt: buildAnswerPrompt(sentence, webSources),
        estOutputTokens: 200,
      });
      if (ans.ok) {
        const text = parseAnswer(ans.text);
        answer = text && text.toLowerCase() !== 'unknown' ? text : null;
      } else {
        degraded = true; // couldn't synthesize; keep the sources as leads.
      }
    }
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
  /** Max web sources to attach. Default 3. */
  maxSources?: number;
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
): Promise<FollowupAnswer> {
  const question = input.question.trim();
  const sentence = (input.context.sentence ?? '').trim();
  const transcript = (input.context.transcript ?? []).map((t) => t.trim()).filter(Boolean);
  let degraded = false;

  // 1) Best-effort web search to ground outside facts with citations. The query
  //    blends the question with the sentence it's about so context-anchored asks
  //    ("how does that compare to X?") retrieve relevant pages.
  let sources: FollowupAnswer['sources'] = [];
  let webSources: WebSource[] = [];
  if (opts.research) {
    const query = buildFollowupQuery(question, sentence);
    try {
      const r = await opts.research.search(query, { maxResults: opts.maxSources ?? 3 });
      webSources = r.sources.filter((s) => s.url);
    } catch {
      webSources = [];
    }
    sources = webSources.map((s, i) => ({
      citation_id: `ct_${input.segment_id}_fu_${i}`,
      type: 'web' as const,
      url: s.url,
      title: s.title,
      snippet: s.snippet.slice(0, 400),
      support_score: s.score ?? 0.5,
    }));
  }

  // 2) Synthesize the answer from conversation context + web sources (one enrich
  //    hop). The gateway's CostMeter enforces the per-tenant ceiling; a refusal
  //    (cost cap) returns !ok → degraded, never throws.
  let answer: string | null = null;
  const res = await gateway.invoke({
    kind: 'enrich',
    tenantId: input.tenant_id,
    prompt: buildFollowupPrompt(question, sentence, transcript, webSources),
    estOutputTokens: 250,
  });
  if (res.ok) {
    const parsed = parseFollowupAnswer(res.text);
    if (!parsed.parsed) {
      // A non-JSON reply (e.g. the deterministic stub provider) is not a real
      // answer — degrade gracefully rather than surfacing the stub's marker text.
      degraded = true;
    } else {
      answer = parsed.answer && parsed.answer.toLowerCase() !== 'unknown' ? parsed.answer : null;
    }
  } else {
    degraded = true;
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
function buildExplainPrompt(sentence: string): string {
  return (
    `You help someone understand a sentence from a live conversation.\n\n` +
    `Sentence: "${sentence}"\n\n` +
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

function buildAnswerPrompt(sentence: string, sources: WebSource[]): string {
  const block = sources
    .map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet.slice(0, 300)}`)
    .join('\n');
  return (
    `A live conversation asked: "${sentence}"\n\n` +
    `Use ONLY these web sources to answer. If they do not contain the answer, ` +
    `reply with exactly "unknown".\n\nSources:\n${block}\n\n` +
    `Reply with ONLY a JSON object: ` +
    `{"answer": "<a 1-3 sentence answer grounded in the sources, or \\"unknown\\">"}`
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
): string {
  const convo = transcript.length
    ? transcript.map((l) => `- ${l}`).join('\n')
    : '(no prior transcript captured)';
  const block = sources.length
    ? sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet.slice(0, 300)}`).join('\n')
    : '(no web sources available)';
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
    `Web sources:\n${block}\n\n` +
    `Reply with ONLY a JSON object, no prose: ` +
    `{"answer": "<a 1-4 sentence answer grounded in the context/sources, or \\"unknown\\">"}`
  );
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

function parseAnswer(text: string): string {
  const obj = firstJsonObject(text) as { answer?: unknown } | null;
  if (obj && typeof obj.answer === 'string') return obj.answer.trim();
  return text.trim().slice(0, 400);
}

/**
 * Strict parse for a follow-up answer: only a JSON object with a string `answer`
 * counts as parsed. A non-JSON reply (the stub provider's marker text) returns
 * `parsed:false` so the caller degrades instead of echoing junk to the user.
 */
function parseFollowupAnswer(text: string): { answer: string | null; parsed: boolean } {
  const obj = firstJsonObject(text) as { answer?: unknown } | null;
  if (obj && typeof obj.answer === 'string') {
    return { answer: obj.answer.trim(), parsed: true };
  }
  return { answer: null, parsed: false };
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
