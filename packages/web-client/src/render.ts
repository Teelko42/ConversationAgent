/**
 * @aizen/web-client — Lane E. The bare Phase-0 client: a HEADLESS renderer of the
 * per-session stream (F03 §6, MVP exit criterion 1). It subscribes to the BD-01
 * bus from seq 0, replays the whole log in seq order, and folds it into a small
 * `RenderModel` — transcript lines, concept cards, insights — that a UI (or a
 * test) reads. No DOM, no wall-clock, no RNG: the render is a pure function of
 * the bus history, so the spine stays deterministic and the E2E test (BD-05) can
 * assert on it.
 *
 * The bus carries two envelope classes (BD-01): F01 (AudioFrame /
 * TranscriptSegment) and F02 (ConceptCard / InsightItem / kg_delta). We render
 * the TranscriptSegments out of F01 and the cards/insights out of F02; AudioFrames
 * and kg_deltas have no UI surface in Phase 0 and are skipped.
 *
 * INV-8 (doc 10 Seam B): a card whose source was superseded arrives again as a
 * `state:'retracted'` revision. The renderer keys cards by their stable `id` and
 * keeps only the LATEST revision, so a retraction UN-renders the card — the final
 * model never shows a card citing superseded text (`assertNoSupersededCitations`
 * over `model.cards` holds).
 */
import type {
  TranscriptSegment,
  ConceptCard,
  InsightItem,
} from '@aizen/contracts';
import type { Envelope, SessionEventBus } from '@aizen/edge-gateway';

/** One rendered transcript row (what the client paints for a segment). */
export interface TranscriptLine {
  seq: number;
  segment_id: string;
  rev: number;
  is_final: boolean;
  speaker: string;
  text: string;
}

/**
 * The headless render result (testable). `transcript` is in `seq` order;
 * `cards` are the LIVE (non-retracted) latest revision of each concept card;
 * `insights` are every rendered InsightItem (each carries ≥1 citation, INV-4).
 */
export interface RenderModel {
  session: string;
  transcript: TranscriptLine[];
  cards: ConceptCard[];
  insights: InsightItem[];
}

/** F02 envelopes carry `message_type`; F01 (frames/segments) do not. */
function isF02(env: Envelope): boolean {
  return 'message_type' in env;
}

/** An F01 envelope that is a TranscriptSegment (has the segment fields), not a frame. */
function asTranscriptSegment(env: Envelope): TranscriptSegment | null {
  if (isF02(env)) return null;
  if ('segment_id' in env && 'text' in env && 'is_final' in env) {
    return env as unknown as TranscriptSegment;
  }
  return null;
}

/** Format one segment into a transcript row. */
function toLine(seg: TranscriptSegment): TranscriptLine {
  return {
    seq: seg.seq,
    segment_id: seg.segment_id,
    rev: seg.rev,
    is_final: seg.is_final,
    speaker: seg.speaker.display_name,
    text: seg.text,
  };
}

/**
 * Subscribe to `session` from seq 0 and fold the replayed log into a
 * `RenderModel`. Because `subscribe(_, 0, _)` replays the full history in seq
 * order (BD-01) before streaming live, calling this AFTER the spine has drained
 * yields the complete final render in one pass.
 *
 * Transcript: kept in arrival (== seq) order. Cards: deduped by stable `id`,
 * latest revision wins, retracted ids drop out (INV-8). Insights: appended in
 * order (revisions could supersede later; Phase-0 emits each once).
 */
export function renderStream(bus: SessionEventBus, session: string): RenderModel {
  const transcript: TranscriptLine[] = [];
  // cards by stable id → latest revision seen; retracted ids are pruned.
  const cardsById = new Map<string, ConceptCard>();
  const insightsById = new Map<string, InsightItem>();

  const unsubscribe = bus.subscribe(session, 0, (env) => {
    const seg = asTranscriptSegment(env);
    if (seg) {
      transcript.push(toLine(seg));
      return;
    }
    if (!isF02(env)) return;
    // F02 routing envelope: discriminate on its payload (intel-worker's F02Out).
    const f02 = env as Envelope & {
      message_type: string;
      card?: ConceptCard;
      insight?: InsightItem;
    };
    if (f02.message_type === 'concept_card' && f02.card) {
      const card = f02.card;
      if (card.state === 'retracted') {
        // INV-8: the source was superseded — un-render the card entirely.
        cardsById.delete(card.id);
      } else {
        cardsById.set(card.id, card);
      }
      return;
    }
    if (f02.message_type === 'insight_item' && f02.insight) {
      insightsById.set(f02.insight.id, f02.insight);
    }
    // kg_delta / kg_* have no Phase-0 UI surface — skip.
  });
  // pure replay: nothing streams after a drained spine, but unsubscribe anyway.
  unsubscribe();

  return {
    session,
    transcript,
    cards: [...cardsById.values()],
    insights: [...insightsById.values()],
  };
}

/** Render the model to plain lines (console output for the run-spine script). */
export function formatRender(model: RenderModel): string[] {
  const lines: string[] = [];
  lines.push(`session ${model.session}`);
  lines.push(`-- transcript (${model.transcript.length} segments, seq order) --`);
  for (const l of model.transcript) {
    const tag = l.is_final ? 'final' : 'partial';
    lines.push(`  [${l.seq}] ${l.speaker} (${tag}, rev ${l.rev}): ${l.text}`);
  }
  lines.push(`-- concept cards (${model.cards.length}) --`);
  for (const c of model.cards) {
    lines.push(`  ${c.surface_form} -> ${c.canonical_name} [${c.kind}, ${c.state}]`);
  }
  lines.push(`-- insights (${model.insights.length}) --`);
  for (const i of model.insights) {
    lines.push(`  ${i.insight_type}: ${i.text} (cites ${i.evidence_segment_ids.length})`);
  }
  return lines;
}
