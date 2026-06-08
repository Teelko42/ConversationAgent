/**
 * Lane D — the LIVE intelligence worker (the "explains the room" engine). This is
 * what makes the running app live up to the pitch: as a conversation streams in, it
 * continuously surfaces the concepts/jargon being discussed, the action items /
 * decisions / open questions being raised, a running "what you've missed" recap, and
 * the relationships between concepts (the knowledge graph) — all on demand of the
 * conversation, with no clicks.
 *
 * It subscribes to FINAL `TranscriptSegment`s on the BD-01 bus, keeps a short rolling
 * window, and — debounced — runs ONE cheap Haiku `extract` call over that window to
 * produce `ConceptCard` / `InsightItem` artifacts + a `KgDelta`, plus a periodic
 * Haiku `summarize` call for the recap. Everything is published as F02 envelopes on
 * the SAME bus, so the existing per-session forward subscriber relays them to the
 * browser with zero extra plumbing (just like `runIntel`/`runEnrich`).
 *
 * This is DELIBERATELY separate from the deterministic `extractFromFinal`
 * (Phase-0, pinned byte-for-byte by contract tests). It is LLM-driven, best-effort,
 * and never blocks: a stubbed/cost-capped gateway, a non-JSON reply, or an empty
 * result simply emits nothing. De-dup state keeps a concept/insight from being
 * re-surfaced; a repeat instead bumps the artifact's `revision` so the client folds
 * it in place.
 *
 * Cost posture: every model call is Haiku (`extract`/`summarize` route there) and is
 * metered by whatever gateway it is handed — the live server hands it a SEPARATE
 * background gateway with its own ceiling, so this never starves the answer path.
 */
import type {
  ConceptCard,
  InsightItem,
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
  KgDelta,
  SessionSummary,
  ConsentContext,
} from '@aizen/contracts';
import { CardKindSchema, InsightTypeSchema, InsightStatusSchema, KgRelationSchema } from '@aizen/contracts';
import type { SessionEventBus, Envelope } from '@aizen/edge-gateway';
import { isStubReply, type LlmGateway } from '@aizen/llm-gateway';

export interface RunLiveIntelHandle {
  /** Stop consuming the bus and cancel pending timers (a final flush is best-effort). */
  stop(): void;
  /** Await every in-flight extraction/summary call (the gateway is async). */
  drain(): Promise<void>;
}

export interface RunLiveIntelOptions {
  /** Tenant uuid stamped on every emitted F02 envelope/artifact. */
  tenantId: string;
  /** Session consent (consent_class / pii_present) stamped on cards + insights. */
  consent: Pick<ConsentContext, 'consent_class' | 'pii_present'>;
  /** Replay from this seq before streaming live (default 0). */
  fromSeq?: number;
  /** Overridable cadence knobs (defaults below) — handy for tests. */
  minNewFinals?: number;
  minIntervalMs?: number;
  idleMs?: number;
  summaryEveryN?: number;
  summaryIntervalMs?: number;
}

// --- cadence defaults --------------------------------------------------------
const MIN_NEW_FINALS = 3; // run extraction once this many new finals have landed…
const MIN_INTERVAL_MS = 5000; // …but no more often than this.
const IDLE_MS = 8000; // backstop: extract trailing finals after a lull.
const SUMMARY_EVERY_N = 12; // regenerate the recap every N finals…
const SUMMARY_INTERVAL_MS = 60000; // …or this often, whichever comes first.
const MAX_WINDOW_LINES = 24;
const MAX_WINDOW_CHARS = 4000;

// Per-reply output caps (kept in the prompt too) so one call can't balloon.
const MAX_CONCEPTS = 6;
const MAX_INSIGHTS = 5;
const MAX_EDGES = 6;

// Allowed enum values, sourced from the contracts so they never drift.
const CARD_KINDS = new Set<string>(CardKindSchema.options);
const INSIGHT_TYPES = new Set<string>(InsightTypeSchema.options);
const INSIGHT_STATUSES = new Set<string>(InsightStatusSchema.options);
const RELATIONS = new Set<string>(KgRelationSchema.options);

/** Wall-clock µs for emitted envelopes (observability only — live path, real clock ok). */
function nowUs(): number {
  return Date.now() * 1000;
}

/** A final transcript line distilled to what the engine needs (+ speaker label). */
interface WindowLine {
  segment_id: string;
  who: string;
  text: string;
}

/** Narrow a bus envelope to a FINAL transcript line (F01; F02 echoes carry message_type). */
function asFinalLine(env: Envelope): WindowLine | null {
  const e = env as {
    message_type?: unknown;
    segment_id?: unknown;
    text?: unknown;
    is_final?: unknown;
    speaker?: { display_name?: unknown };
  };
  if (!e || e.message_type !== undefined) return null;
  if (typeof e.segment_id !== 'string' || typeof e.text !== 'string' || e.is_final !== true) return null;
  const text = e.text.trim();
  if (!text) return null;
  const who =
    e.speaker && typeof e.speaker.display_name === 'string' && e.speaker.display_name
      ? e.speaker.display_name
      : 'Speaker';
  return { segment_id: e.segment_id, who, text };
}

export function runLiveIntel(
  session: string,
  bus: SessionEventBus,
  gateway: LlmGateway,
  opts: RunLiveIntelOptions,
): RunLiveIntelHandle {
  const tenantId = opts.tenantId;
  const consentClass = opts.consent.consent_class;
  const piiPresent = opts.consent.pii_present;
  const minNewFinals = opts.minNewFinals ?? MIN_NEW_FINALS;
  const minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const summaryEveryN = opts.summaryEveryN ?? SUMMARY_EVERY_N;
  const summaryIntervalMs = opts.summaryIntervalMs ?? SUMMARY_INTERVAL_MS;

  // Rolling window of recent finals (oldest→newest), capped by lines AND chars.
  const window: WindowLine[] = [];
  // De-dup / revision state. A concept already surfaced is UPDATED (revision++),
  // never duplicated; same for an insight. Edges are de-duped by endpoints+relation.
  const seenCards = new Map<
    string,
    { id: string; nodeId: string; rev: number; mentions: string[]; canonical: string }
  >();
  const seenInsights = new Map<string, { id: string; rev: number }>();
  const seenEdges = new Set<string>();
  let cardCounter = 0;
  let insightCounter = 0;
  let edgeCounter = 0;
  let deltaSeq = 0;

  // Trigger bookkeeping.
  let newSinceRun = 0;
  let lastRunAt = 0;
  let finalsSinceSummary = 0;
  let lastSummaryAt = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let extractInFlight = false;
  let summaryInFlight = false;
  let stopped = false;
  const inFlight = new Set<Promise<void>>();

  // --- publishing -----------------------------------------------------------
  type F02MsgType = 'concept_card' | 'insight_item' | 'kg_delta' | 'session_summary';
  function publishF02(payload: Record<string, unknown>, messageType: F02MsgType): void {
    const seq = bus.nextSeq(session, 'f02');
    const env = {
      schema_version: '1.0.0',
      message_type: messageType,
      session_id: session,
      tenant_id: tenantId,
      seq,
      ts_emit: nowUs(),
      producer: 'live-intel',
      trace_id: `trace_${session}_f02_${seq}`,
      ...payload,
    };
    bus.publish(session, env as unknown as Envelope);
  }

  // --- helpers --------------------------------------------------------------
  function clearIdle(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  function trimWindow(): void {
    while (window.length > MAX_WINDOW_LINES) window.shift();
    let chars = window.reduce((n, l) => n + l.text.length, 0);
    while (chars > MAX_WINDOW_CHARS && window.length > 1) {
      const dropped = window.shift()!;
      chars -= dropped.text.length;
    }
  }

  /** Resolve a model-supplied line ref (a `[n]` index or a raw segment_id) to a segment_id. */
  function resolveSeg(ref: unknown, snap: WindowLine[]): string {
    const last = snap.length ? snap[snap.length - 1]!.segment_id : 'seg_unknown';
    if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < snap.length) {
      return snap[ref]!.segment_id;
    }
    if (typeof ref === 'string') {
      const n = Number(ref);
      if (Number.isInteger(n) && n >= 0 && n < snap.length) return snap[n]!.segment_id;
      const hit = snap.find((w) => w.segment_id === ref);
      if (hit) return hit.segment_id;
    }
    return last;
  }

  function lineTextFor(seg: string, snap: WindowLine[]): string {
    return snap.find((w) => w.segment_id === seg)?.text ?? '';
  }

  function clamp01(n: unknown, dflt: number): number {
    return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : dflt;
  }

  function cardKindOf(k: unknown): ConceptCard['kind'] {
    return typeof k === 'string' && CARD_KINDS.has(k) ? (k as ConceptCard['kind']) : 'concept';
  }
  function nodeTypeOf(kind: ConceptCard['kind']): KnowledgeGraphNode['node_type'] {
    if (kind.startsWith('entity_')) return 'entity';
    if (kind === 'topic') return 'topic';
    if (kind === 'event') return 'event';
    return 'concept';
  }
  function relationOf(r: unknown): KnowledgeGraphEdge['relation'] {
    return typeof r === 'string' && RELATIONS.has(r)
      ? (r as KnowledgeGraphEdge['relation'])
      : 'related_to';
  }
  function insightTypeOf(t: unknown): InsightItem['insight_type'] | null {
    return typeof t === 'string' && INSIGHT_TYPES.has(t) ? (t as InsightItem['insight_type']) : null;
  }
  function insightStatusOf(s: unknown): InsightItem['status'] {
    return typeof s === 'string' && INSIGHT_STATUSES.has(s) ? (s as InsightItem['status']) : 'open';
  }

  // --- emit (build contract objects + publish) ------------------------------
  function emitConcept(c: RawConcept, snap: WindowLine[], newNodes: KnowledgeGraphNode[]): void {
    const canonical = String(c.canonical_name ?? c.surface_form ?? '').trim();
    if (!canonical) return;
    const key = canonical.toLowerCase();
    const seg = resolveSeg(c.segment_id, snap);
    const kind = cardKindOf(c.kind);
    const salience = clamp01(c.salience, 0.5);
    const surface = String(c.surface_form ?? canonical).trim() || canonical;

    let entry = seenCards.get(key);
    const isNew = !entry;
    if (entry) {
      if (!entry.mentions.includes(seg)) entry.mentions.push(seg);
      entry.rev += 1;
    } else {
      cardCounter += 1;
      entry = {
        id: `cc_live_${cardCounter}`,
        nodeId: `kgn_live_${cardCounter}`,
        rev: 1,
        mentions: [seg],
        canonical,
      };
      seenCards.set(key, entry);
    }

    const card: ConceptCard = {
      id: entry.id,
      revision: entry.rev,
      state: 'enriched',
      session_id: session,
      tenant_id: tenantId,
      surface_form: surface,
      canonical_name: canonical,
      kind,
      domain: 'general',
      salience,
      ...(typeof c.definition_short === 'string' && c.definition_short.trim()
        ? { definition_short: c.definition_short.trim() }
        : {}),
      sources: [
        {
          citation_id: `ct_${entry.id}_t`,
          type: 'transcript',
          transcript_segment_ids: [seg],
          snippet: lineTextFor(seg, snap) || surface,
        },
      ],
      graph_node_id: entry.nodeId,
      first_mention: { segment_id: entry.mentions[0]!, t_start_us: 0, speaker_id: 'live' },
      mention_count: entry.mentions.length,
      mention_segment_ids: [...entry.mentions],
      grounding: {
        grounded: false,
        groundedness_score: 0.4,
        verification_state: 'unverified',
        hallucination_flags: [],
      },
      consent_class: consentClass,
      pii_present: piiPresent,
      retraction: null,
    };
    publishF02({ card }, 'concept_card');

    if (isNew) {
      newNodes.push({
        id: entry.nodeId,
        revision: 1,
        session_id: session,
        tenant_id: tenantId,
        label: canonical,
        node_type: nodeTypeOf(kind),
        concept_card_id: entry.id,
        salience,
        first_seen_segment_id: seg,
        first_seen_t_us: nowUs(),
        consent_class: consentClass,
      });
    }
  }

  function emitEdge(e: RawEdge, newEdges: KnowledgeGraphEdge[]): void {
    const a = seenCards.get(String(e.from ?? '').trim().toLowerCase());
    const b = seenCards.get(String(e.to ?? '').trim().toLowerCase());
    if (!a || !b || a.nodeId === b.nodeId) return;
    const relation = relationOf(e.relation);
    const dedup = `${a.nodeId}->${b.nodeId}:${relation}`;
    if (seenEdges.has(dedup)) return;
    seenEdges.add(dedup);
    edgeCounter += 1;
    newEdges.push({
      id: `kge_live_${edgeCounter}`,
      revision: 1,
      session_id: session,
      tenant_id: tenantId,
      src: a.nodeId,
      dst: b.nodeId,
      relation,
      directed: true,
    });
  }

  function emitInsight(i: RawInsight, snap: WindowLine[]): void {
    const type = insightTypeOf(i.type);
    if (!type) return;
    const text = String(i.text ?? '').trim();
    if (!text) return;
    // Drop insights that are meta-commentary about the capture pipeline (poor audio,
    // background noise, possible mistranscription, …) rather than about what's being
    // discussed. The model keeps re-raising these as "risks"/"open questions"; they're
    // about the tool, not the conversation, so they never reach the listener.
    if (isAudioMetaInsight(text)) return;
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    const evidence = resolveEvidence(i.evidence_segment_ids, snap);

    let entry = seenInsights.get(key);
    if (entry) entry.rev += 1;
    else {
      insightCounter += 1;
      entry = { id: `ins_live_${insightCounter}`, rev: 1 };
      seenInsights.set(key, entry);
    }

    const insight: InsightItem = {
      id: entry.id,
      revision: entry.rev,
      session_id: session,
      tenant_id: tenantId,
      insight_type: type,
      status: insightStatusOf(i.status),
      text,
      owner_speaker_id: typeof i.owner === 'string' && i.owner.trim() ? i.owner.trim() : null,
      evidence_segment_ids: evidence,
      first_seen_t_us: nowUs(),
      consent_class: consentClass,
      pii_present: piiPresent,
    };
    publishF02({ insight }, 'insight_item');
  }

  function resolveEvidence(refs: unknown, snap: WindowLine[]): string[] {
    const out: string[] = [];
    if (Array.isArray(refs)) {
      for (const r of refs) {
        const seg = resolveSeg(r, snap);
        if (!out.includes(seg)) out.push(seg);
      }
    }
    if (out.length === 0) out.push(resolveSeg(undefined, snap)); // INV-4: ≥1 evidence.
    return out;
  }

  // --- the two model calls --------------------------------------------------
  function runExtraction(): void {
    if (stopped || extractInFlight || window.length === 0) return;
    extractInFlight = true;
    lastRunAt = Date.now();
    newSinceRun = 0;
    clearIdle();
    const snap = window.slice();
    const known = [...seenCards.values()].map((e) => e.canonical).slice(-40);
    const openInsights = [...seenInsights.keys()].slice(-20);
    const work = gateway
      .invoke({
        kind: 'extract',
        tenantId,
        prompt: buildExtractPrompt(snap, known, openInsights),
        estOutputTokens: 500,
      })
      .then((res) => {
        if (!res.ok || isStubReply(res.text)) return;
        const parsed = parseExtraction(res.text);
        const newNodes: KnowledgeGraphNode[] = [];
        const newEdges: KnowledgeGraphEdge[] = [];
        for (const c of parsed.concepts.slice(0, MAX_CONCEPTS)) emitConcept(c, snap, newNodes);
        for (const e of parsed.edges.slice(0, MAX_EDGES)) emitEdge(e, newEdges);
        for (const ins of parsed.insights.slice(0, MAX_INSIGHTS)) emitInsight(ins, snap);
        if (newNodes.length || newEdges.length) {
          deltaSeq += 1;
          const delta: KgDelta = {
            session_id: session,
            delta_seq: deltaSeq,
            upsert_nodes: newNodes,
            upsert_edges: newEdges,
            remove_node_ids: [],
            remove_edge_ids: [],
            snapshot_offer: false,
          };
          publishF02({ delta }, 'kg_delta');
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console -- best-effort; the conversation already rendered.
        console.error('[live-intel] extraction failed:', err);
      })
      .finally(() => {
        extractInFlight = false;
        inFlight.delete(work);
      });
    inFlight.add(work);
  }

  function runSummary(): void {
    if (stopped || summaryInFlight || window.length === 0) return;
    summaryInFlight = true;
    lastSummaryAt = Date.now();
    finalsSinceSummary = 0;
    const snap = window.slice();
    const work = gateway
      .invoke({
        kind: 'summarize',
        tenantId,
        prompt: buildSummaryPrompt(snap),
        estOutputTokens: 300,
      })
      .then((res) => {
        if (!res.ok || isStubReply(res.text)) return;
        const parsed = parseSummary(res.text);
        if (!parsed.text) return;
        const summary: SessionSummary = {
          text: parsed.text,
          bullets: parsed.bullets,
          updated_at_us: nowUs(),
        };
        publishF02({ summary }, 'session_summary');
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[live-intel] summary failed:', err);
      })
      .finally(() => {
        summaryInFlight = false;
        inFlight.delete(work);
      });
    inFlight.add(work);
  }

  // --- trigger --------------------------------------------------------------
  function maybeTrigger(): void {
    const now = Date.now();
    if (newSinceRun >= minNewFinals && now - lastRunAt >= minIntervalMs) {
      runExtraction();
    } else {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (newSinceRun > 0) runExtraction();
      }, idleMs);
      if (typeof (idleTimer as { unref?: () => void }).unref === 'function') {
        (idleTimer as { unref?: () => void }).unref!();
      }
    }
    const summaryDue =
      finalsSinceSummary >= summaryEveryN ||
      (lastSummaryAt > 0 && now - lastSummaryAt >= summaryIntervalMs);
    if (summaryDue) runSummary();
  }

  // --- bus subscription -----------------------------------------------------
  const unsub = bus.subscribe(session, opts.fromSeq ?? 0, (env) => {
    if (stopped) return;
    const line = asFinalLine(env);
    if (!line) return; // F02 echoes (incl. our own) + non-final F01 — ignore.
    window.push(line);
    trimWindow();
    newSinceRun += 1;
    finalsSinceSummary += 1;
    maybeTrigger();
  });

  return {
    stop: () => {
      if (stopped) return;
      clearIdle();
      unsub();
      // Best-effort final flush so the last things said get carded + recapped; both
      // are tracked in `inFlight`, so `drain()` (awaited by the session) waits for them.
      if (window.length && newSinceRun > 0) runExtraction();
      runSummary();
      stopped = true;
    },
    drain: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

// ---------------------------------------------------------------------------
// Audio/transcription-pipeline meta filter
// ---------------------------------------------------------------------------
// The extractor sometimes raises "risks" / "open questions" about the CAPTURE pipeline
// itself — poor audio, background noise, a chance of mistranscription — instead of
// about the subject being discussed. Those are noise to the listener (and keep
// recurring), so they're excluded. Tuned to the pipeline-meta phrasings the model
// actually produces, so a genuine insight that merely mentions "audio" (e.g. an
// audio-product roadmap item, "audio latency") is left alone.
const AUDIO_META_RE = new RegExp(
  [
    '(?:audio|sound|voice|call|recording)\\s+quality',
    '(?:poor|bad|low|unclear|muffled|distorted|choppy|garbled|noisy)\\s+audio',
    'audio\\s+(?:is|was|may|might|could|seems|appears|being|cut|cutting|dropping|drops|issue|problem|clarity|unclear|quality|level)',
    'background\\s+noise',
    'ambient\\s+noise',
    'static\\s+(?:noise|interference|on the line)',
    '\\bmicrophone\\b',
    '\\bmic\\b',
    'inaudible',
    'muffled',
    'garbled',
    'hard\\s+to\\s+hear',
    'difficult\\s+to\\s+hear',
    "can(?:no|')t\\s+hear",
    'cannot\\s+hear',
    'barely\\s+audible',
    'speech\\s+recognition',
    'speech[\\s-]to[\\s-]text',
    'transcript(?:ion)?\\s+(?:accuracy|error|errors|quality|issue|problem|may|might|could|reliab)',
    'mis-?transcri',
    'transcrib(?:e|ed|ing)\\s+(?:incorrectly|inaccurately|wrongly)',
    'misheard',
    'mishearing',
    '(?:may|might|could)\\s+(?:be\\s+)?mis-?(?:heard|transcribed)',
  ].join('|'),
  'i',
);

/** True when an insight is meta-commentary about the audio/transcription pipeline
 *  rather than about the conversation's subject — those are excluded from output. */
export function isAudioMetaInsight(text: string): boolean {
  return AUDIO_META_RE.test(String(text || ''));
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
function buildExtractPrompt(window: WindowLine[], known: string[], openInsights: string[]): string {
  const lines = window.map((l, i) => `[${i}] ${l.who}: ${l.text}`).join('\n');
  const knownBlock = known.length ? known.join(', ') : '(none yet)';
  const trackedBlock = openInsights.length ? openInsights.map((t) => `- ${t}`).join('\n') : '(none yet)';
  return (
    `You are the live intelligence engine for a conversation copilot that explains and ` +
    `tracks everything being discussed. From the recent transcript window, surface the ` +
    `NEW concepts/jargon/acronyms/entities a listener would want explained, and the NEW ` +
    `action items / decisions / open questions / risks / commitments being raised. Be ` +
    `precise and grounded in what was actually said — never invent. Never raise insights ` +
    `about the audio, recording, microphone, connection, or transcription quality itself ` +
    `(e.g. background noise, poor/unclear audio, possible mistranscription, "hard to ` +
    `hear") — those are about the capture tool, not the conversation; only surface ` +
    `insights about the subject being discussed.\n\n` +
    `Recent conversation (each line is "[n] speaker: text"):\n${lines}\n\n` +
    `Concepts already surfaced (do NOT repeat these; only add genuinely new ones):\n${knownBlock}\n\n` +
    `Insights already tracked:\n${trackedBlock}\n\n` +
    `Reply with ONLY a JSON object, no prose:\n` +
    `{"concepts":[{"surface_form":"<as said>","canonical_name":"<full/proper name>",` +
    `"kind":"<one of: topic|concept|acronym|jargon_term|metric|event|reference|` +
    `entity_person|entity_org|entity_product|entity_location|entity_financial_instrument|` +
    `entity_legal_ref|entity_medical>","definition_short":"<one plain-language sentence ` +
    `explaining it in this context>","salience":<0..1>,"segment_id":<the [n] line number ` +
    `of the primary mention>}],` +
    `"insights":[{"type":"<one of: action_item|decision|open_question|risk|commitment>",` +
    `"text":"<concise, self-contained>","owner":"<speaker name or null>",` +
    `"evidence_segment_ids":[<[n] line numbers>]}],` +
    `"edges":[{"from":"<a concept canonical_name>","to":"<a concept canonical_name>",` +
    `"relation":"<one of: related_to|is_a|part_of|causes|depends_on|contrasts_with|` +
    `example_of|defines|references>"}]}\n` +
    `Only include genuinely notable, correct items. If nothing new, use empty arrays. ` +
    `At most ${MAX_CONCEPTS} concepts, ${MAX_INSIGHTS} insights, ${MAX_EDGES} edges.`
  );
}

function buildSummaryPrompt(window: WindowLine[]): string {
  const lines = window.map((l) => `${l.who}: ${l.text}`).join('\n');
  return (
    `Summarize this live conversation for someone catching up. Be faithful to what was ` +
    `actually said; do not invent.\n\n` +
    `Transcript (most recent last):\n${lines}\n\n` +
    `Reply with ONLY a JSON object: {"paragraph":"<2-3 sentence recap of what's been ` +
    `discussed so far>","bullets":["<key point>", ... up to 6]}`
  );
}

// ---------------------------------------------------------------------------
// Lenient parsing (mirrors explain.ts: take the first {...} block)
// ---------------------------------------------------------------------------
interface RawConcept {
  surface_form?: unknown;
  canonical_name?: unknown;
  kind?: unknown;
  definition_short?: unknown;
  salience?: unknown;
  segment_id?: unknown;
}
interface RawInsight {
  type?: unknown;
  text?: unknown;
  owner?: unknown;
  status?: unknown;
  evidence_segment_ids?: unknown;
}
interface RawEdge {
  from?: unknown;
  to?: unknown;
  relation?: unknown;
}

function firstJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseExtraction(text: string): {
  concepts: RawConcept[];
  insights: RawInsight[];
  edges: RawEdge[];
} {
  const obj = firstJsonObject(text);
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    concepts: arr(obj?.concepts).filter((c): c is RawConcept => !!c && typeof c === 'object'),
    insights: arr(obj?.insights).filter((i): i is RawInsight => !!i && typeof i === 'object'),
    edges: arr(obj?.edges).filter((e): e is RawEdge => !!e && typeof e === 'object'),
  };
}

function parseSummary(text: string): { text: string; bullets: string[] } {
  const obj = firstJsonObject(text);
  if (obj && typeof obj.paragraph === 'string') {
    const bullets = Array.isArray(obj.bullets)
      ? obj.bullets.filter((b): b is string => typeof b === 'string' && !!b.trim()).map((b) => b.trim()).slice(0, 6)
      : [];
    return { text: obj.paragraph.trim(), bullets };
  }
  // Non-JSON fallback: keep the raw text as the recap paragraph.
  return { text: text.trim().slice(0, 600), bullets: [] };
}
