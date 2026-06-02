/**
 * Lane D — P2 enrichment (the wedge). A skeleton `ConceptCard` (heuristic
 * surface form, no meaning) becomes an `enriched` revision carrying a real,
 * grounded explanation: a Sonnet call via the gateway (`kind:'enrich'` → the hot
 * path, D04) optionally fed sourced background from a `WebSearchProvider`
 * (P2-C lite). Every web claim is attached as a `type:'web'` Citation (INV-1/2)
 * so F03 can show provenance.
 *
 * GROUNDING / anti-hallucination posture: the prompt pins the model to the
 * transcript snippet + retrieved sources and asks for "unknown" when unsupported.
 * If the gateway degrades (cost ceiling, etc.) the skeleton card is returned
 * unchanged — enrichment is best-effort and never blocks the skeleton render.
 *
 * This path is SEPARATE from the deterministic `extractFromFinal` (which the
 * Phase-0 tests pin byte-for-byte) — it only runs in the live server wiring.
 */
import type { ConceptCard } from '@aizen/contracts';
import type { LlmGateway } from '@aizen/llm-gateway';
import type { WebSearchProvider, WebSource } from '@aizen/research';

export interface EnrichOptions {
  /** Web search for sourced background. Omit to ground on the transcript only. */
  research?: WebSearchProvider;
  /** Max web sources to attach. Default 3. */
  maxSources?: number;
}

/** What the model is asked to return; parsed leniently from its reply. */
interface Enrichment {
  canonical_name: string;
  definition: string;
}

/**
 * Enrich one skeleton card. Returns a NEW `enriched` revision, or the original
 * card unchanged if the gateway degraded. Pure w.r.t. its inputs (no global state).
 */
export async function enrichCard(
  card: ConceptCard,
  gateway: LlmGateway,
  opts: EnrichOptions = {},
): Promise<ConceptCard> {
  const transcriptSnippet =
    card.sources.find((s) => s.type === 'transcript')?.snippet ?? card.surface_form;

  // 1) Optional sourced background (degrade silently to transcript-only).
  let webSources: WebSource[] = [];
  if (opts.research) {
    try {
      const r = await opts.research.search(`${card.surface_form} meaning definition`, {
        maxResults: opts.maxSources ?? 3,
      });
      webSources = r.sources.filter((s) => s.url);
    } catch {
      webSources = [];
    }
  }

  // 2) Grounded enrich call (Sonnet via routeTier('enrich')).
  const res = await gateway.invoke({
    kind: 'enrich',
    tenantId: card.tenant_id,
    prompt: buildPrompt(card.surface_form, transcriptSnippet, webSources),
    estOutputTokens: 256,
  });
  if (!res.ok) return card; // degraded — keep the skeleton (best-effort).

  const parsed = parseEnrichment(res.text, card.surface_form);

  // 3) Assemble the enriched revision.
  const webCitations = webSources.map((s, i) => ({
    citation_id: `ct_${card.id}_web_${i}`,
    type: 'web' as const,
    url: s.url,
    title: s.title,
    snippet: s.snippet.slice(0, 400),
    trust_tier: 'T3' as const,
    support_score: s.score ?? 0.5,
  }));

  return {
    ...card,
    revision: card.revision + 1,
    state: 'enriched',
    canonical_name: parsed.canonical_name || card.canonical_name,
    definition_short: parsed.definition,
    sources: [...card.sources, ...webCitations],
    grounding: {
      grounded: webSources.length > 0,
      groundedness_score: webSources.length > 0 ? 0.7 : 0.4,
      verification_state: 'unverified',
      hallucination_flags: [],
    },
  };
}

/** Build the grounded enrich prompt; the model must answer as a JSON object. */
function buildPrompt(surface: string, snippet: string, sources: WebSource[]): string {
  const sourceBlock = sources.length
    ? `\nBackground sources:\n${sources
        .map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet.slice(0, 300)}`)
        .join('\n')}\n`
    : '\n(no external sources available — rely on the transcript and your knowledge)\n';

  return (
    `A live conversation just mentioned the term "${surface}".\n` +
    `Transcript context: "${snippet}"\n` +
    sourceBlock +
    `\nReply with ONLY a JSON object, no prose, of the form:\n` +
    `{"canonical_name": "<the full/proper name of ${surface}>", ` +
    `"definition": "<one or two plain-language sentences explaining what it means ` +
    `in this context; write \\"unknown\\" if you cannot ground it>"}`
  );
}

/**
 * Lenient parse of the model reply: extract the first {...} block and JSON-parse
 * it; fall back to (surface, trimmed-text) so a non-JSON reply still enriches.
 */
function parseEnrichment(text: string, surface: string): Enrichment {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as Partial<Enrichment>;
      return {
        canonical_name: (obj.canonical_name ?? surface).trim(),
        definition: (obj.definition ?? '').trim(),
      };
    } catch {
      /* fall through to the text fallback */
    }
  }
  return { canonical_name: surface, definition: text.trim().slice(0, 400) };
}
