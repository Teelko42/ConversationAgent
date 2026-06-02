/**
 * Lane D — the enrichment worker (P2-B "explain engine", lite). Subscribes to the
 * BD-01 bus, picks up every `skeleton` ConceptCard the extractor publishes, runs
 * `enrichCard` (Sonnet enrich + optional web grounding), and republishes the
 * result as a higher-revision `enriched` F02 envelope. The web-client folds cards
 * by stable `id` keeping the latest revision, so the enriched card replaces the
 * skeleton in place.
 *
 * Feedback-safe: only `state:'skeleton'` cards are enriched, so the worker never
 * re-processes its own `enriched` output. Enrichment runs concurrently per card
 * (real-time); `drain()` awaits all in-flight work for tests/shutdown.
 */
import type { ConceptCard, F02Envelope } from '@aizen/contracts';
import type { SessionEventBus, Envelope } from '@aizen/edge-gateway';
import type { LlmGateway } from '@aizen/llm-gateway';
import type { WebSearchProvider } from '@aizen/research';
import { enrichCard } from './enrich.js';

export interface RunEnrichHandle {
  stop(): void;
  /** Await every in-flight enrichment (the gateway/search are async). */
  drain(): Promise<void>;
}

export interface RunEnrichOptions {
  /** Web search provider for sourced background (omit ⇒ transcript-only). */
  research?: WebSearchProvider;
  /** Replay from this seq before streaming live (default 0). */
  fromSeq?: number;
  /** Max web sources per card. */
  maxSources?: number;
}

/** Wall-clock µs for the emitted F02 envelope (observability only). */
function nowUs(): number {
  return Date.now() * 1000;
}

/** Narrow a bus envelope to an F02 concept_card payload, if it is one. */
function asConceptCard(env: Envelope): ConceptCard | null {
  if (!('message_type' in env)) return null;
  const e = env as Envelope & { message_type: string; card?: ConceptCard };
  if (e.message_type !== 'concept_card' || !e.card) return null;
  return e.card;
}

export function runEnrich(
  session: string,
  bus: SessionEventBus,
  gateway: LlmGateway,
  opts: RunEnrichOptions = {},
): RunEnrichHandle {
  const inFlight = new Set<Promise<void>>();

  const publish = (card: ConceptCard): void => {
    const seq = bus.nextSeq(session, 'f02');
    const base: F02Envelope = {
      schema_version: '1.0.0',
      message_type: 'concept_card',
      session_id: session,
      tenant_id: card.tenant_id,
      seq,
      ts_emit: nowUs(),
      producer: 'explain-engine',
      trace_id: `trace_${session}_f02_${seq}`,
    };
    // F02 routing envelope + typed payload (mirrors runIntel's F02Out publish).
    bus.publish(session, { ...base, card } as unknown as Envelope);
  };

  const onEnvelope = (env: Envelope): void => {
    const card = asConceptCard(env);
    if (!card || card.state !== 'skeleton') return; // only enrich skeletons.

    const work = enrichCard(card, gateway, {
      research: opts.research,
      maxSources: opts.maxSources,
    })
      .then((enriched) => {
        // Only publish if enrichment actually advanced the card.
        if (enriched.state === 'enriched' && enriched.revision > card.revision) {
          publish(enriched);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console -- best-effort; skeleton already rendered.
        console.error(`[enrich] failed for card ${card.id}:`, err);
      })
      .finally(() => {
        inFlight.delete(work);
      });
    inFlight.add(work);
  };

  const unsub = bus.subscribe(session, opts.fromSeq ?? 0, onEnvelope);

  return {
    stop: unsub,
    drain: async () => {
      // settle waves: enrichment may publish nothing further, but await all.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
