import type {
  ExtractionInput,
  ConceptCard,
  InsightItem,
  KgDelta,
  KnowledgeGraphNode,
} from '@aizen/contracts';
import type { LlmGateway } from '@aizen/llm-gateway';

/**
 * Lane D — F02 extraction (doc 10 §1 / PLAN). From a single FINAL
 * `ExtractionInput`, produce the Phase-0 skeleton artifacts: a `ConceptCard`
 * (`state:'skeleton'`) per salient surface form, an `InsightItem` per card with
 * ≥1 transcript citation (INV-4), and one `kg_delta` (monotonic `delta_seq`).
 *
 * Salience/term selection is a deterministic Phase-0 heuristic — capitalized /
 * acronym tokens — NOT an LLM judgement. The gateway is still invoked
 * (`kind:'extract'` → Haiku via routeTier) so the seam to the real extractor is
 * wired and cost-metered (BD-03/BD-04); its text is not parsed in Phase 0.
 *
 * DETERMINISM: ids/timestamps derive only from the input (segment_id, seq,
 * t_*_us) — no wall-clock, no RNG. Re-running on the same input is byte-stable.
 */

export interface ExtractResult {
  cards: ConceptCard[];
  insights: InsightItem[];
  kgDelta: KgDelta;
}

/** Heuristic salient surface forms: ALL-CAPS acronyms + Capitalized words. */
export function salientTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // word tokens of letters/digits; preserves source order, de-duped.
  for (const tok of text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    const isAcronym = tok.length >= 2 && tok === tok.toUpperCase() && /[A-Z]/.test(tok);
    const first = tok[0]!;
    const isCapitalized = first === first.toUpperCase() && first !== first.toLowerCase();
    if (!(isAcronym || isCapitalized)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/** Acronyms (all-caps, len≥2) classify as `acronym`; else a generic `concept`. */
function kindOf(term: string): ConceptCard['kind'] {
  return term.length >= 2 && term === term.toUpperCase() ? 'acronym' : 'concept';
}

/**
 * Build the skeleton artifacts for one final segment. The gateway call carries
 * the extraction prompt (`kind:'extract'`); its result is awaited so cost
 * accounting runs, but Phase-0 cards are heuristic, not parsed from the stub.
 */
export async function extractFromFinal(
  input: ExtractionInput,
  gateway: LlmGateway,
  deltaSeq: number,
): Promise<ExtractResult> {
  // Wire the gateway seam (BD-04): extract → Haiku via routeTier. Result text is
  // not consumed in Phase 0; the call exists so the swap-in point is real.
  await gateway.invoke({
    kind: 'extract',
    tenantId: input.tenant_id,
    prompt: input.text,
  });

  const terms = salientTerms(input.text);
  const cards: ConceptCard[] = [];
  const insights: InsightItem[] = [];
  const upsertNodes: KnowledgeGraphNode[] = [];

  terms.forEach((term, i) => {
    // Deterministic, collision-free ids derived from segment_id + ordinal.
    const cardId = `cc_${input.segment_id}_${i}`;
    const nodeId = `kgn_${input.segment_id}_${i}`;
    const insightId = `ins_${input.segment_id}_${i}`;

    const card: ConceptCard = {
      id: cardId,
      revision: 1,
      state: 'skeleton',
      session_id: input.session_id,
      tenant_id: input.tenant_id,
      surface_form: term,
      canonical_name: term, // skeleton: canonicalization is the enrich tier's job.
      kind: kindOf(term),
      domain: 'general',
      salience: 0.5,
      sources: [
        {
          citation_id: `ct_${input.segment_id}_${i}`,
          type: 'transcript',
          transcript_segment_ids: [input.segment_id], // INV-4 grounding.
          snippet: input.text,
        },
      ],
      graph_node_id: nodeId,
      first_mention: {
        segment_id: input.segment_id,
        t_start_us: input.t_start_us,
        speaker_id: input.speaker_id,
      },
      mention_segment_ids: [input.segment_id],
      consent_class: input.consent_class, // CT-INT-5 passthrough (fail-closed if upstream did).
      pii_present: input.pii_present,
      retraction: null,
    };
    cards.push(card);

    insights.push({
      id: insightId,
      revision: 1,
      session_id: input.session_id,
      tenant_id: input.tenant_id,
      insight_type: 'open_question',
      status: 'open',
      text: term,
      owner_speaker_id: input.speaker_id,
      evidence_segment_ids: [input.segment_id], // INV-4: ≥1, non-empty.
      first_seen_t_us: input.t_start_us,
      graph_node_id: nodeId,
      consent_class: input.consent_class,
      pii_present: input.pii_present,
    });

    upsertNodes.push({
      id: nodeId,
      revision: 1,
      session_id: input.session_id,
      tenant_id: input.tenant_id,
      label: term,
      node_type: 'concept',
      concept_card_id: cardId,
      first_seen_segment_id: input.segment_id,
      first_seen_t_us: input.t_start_us,
      consent_class: input.consent_class,
    });
  });

  const kgDelta: KgDelta = {
    session_id: input.session_id,
    delta_seq: deltaSeq,
    upsert_nodes: upsertNodes,
    upsert_edges: [],
    remove_node_ids: [],
    remove_edge_ids: [],
    snapshot_offer: false,
  };

  return { cards, insights, kgDelta };
}
