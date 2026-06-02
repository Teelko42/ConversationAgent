import type {
  TranscriptSegment,
  ConsentContext,
  ConceptCard,
  InsightItem,
  KgDelta,
  F02Envelope,
  F02MessageType,
} from '@aizen/contracts';
import type { SessionEventBus, Envelope } from '@aizen/edge-gateway';
import type { LlmGateway } from '@aizen/llm-gateway';
import { adapt } from '@aizen/adapter-d16';
import {
  ProvenanceIndex,
  InMemoryArtifactStore,
  propagateSupersede,
  type ReExtractor,
} from '@aizen/seam-supersede';
import { DeltaIndex } from '@aizen/seam-kg-resync';
import { extractFromFinal } from './extract.js';

/**
 * Lane D — `runIntel` (PLAN). The F02 ingress→extraction hot path on the BD-01
 * bus: subscribe F01 `TranscriptSegment`s, run them through the D16 `adapt()`
 * (the ONLY reader of raw F01 fields), and ON FINALS extract skeleton artifacts
 * and publish them as F02 envelopes. A final that `supersedes` a prior segment
 * drives the supersede seam (INV-8) and publishes the resulting retractions.
 *
 * Reuses the foundation as-is (BD-04): adapter, supersede/provenance seam,
 * delta index, LLM gateway. No data shapes are reinvented — all come from
 * `@aizen/contracts`.
 *
 * DETERMINISM: `ts_emit`/`trace_id` are fixed constants (mirroring fixtures'
 * emitted_at / session_start_at); the worker calls no wall-clock or RNG.
 */

/** Fixed wall-clock µs for emitted F02 envelopes (observability-only; INV: no clock). */
const TS_EMIT = 1748707202000000;

/** The payload carried alongside an F02 routing envelope. */
export type F02Payload =
  | { message_type: 'concept_card'; card: ConceptCard }
  | { message_type: 'insight_item'; insight: InsightItem }
  | { message_type: 'kg_delta'; delta: KgDelta };

/** An F02 envelope plus its typed payload — what `runIntel` publishes. */
export type F02Out = F02Envelope & F02Payload;

/** Anything narrowed off the bus that looks like a TranscriptSegment (F01 class). */
function asTranscriptSegment(env: Envelope): TranscriptSegment | null {
  // F02 envelopes carry `message_type`; F01 do not. A TranscriptSegment is an
  // F01 envelope with the segment fields (it extends F01EnvelopeSchema).
  if ('message_type' in env) return null;
  if ('segment_id' in env && 'text' in env && 'is_final' in env) {
    return env as unknown as TranscriptSegment;
  }
  return null;
}

export interface RunIntelHandle {
  /** Stop consuming the bus. */
  stop(): void;
  /** Await all in-flight extraction/propagation work (gateway is async). */
  drain(): Promise<void>;
  /** The live provenance/artifact state (inspection / tests). */
  index: ProvenanceIndex;
  store: InMemoryArtifactStore;
  deltaIndex: DeltaIndex;
}

export interface RunIntelOptions {
  /** Replay from this seq before streaming live (default 0 — full history). */
  fromSeq?: number;
  /** F04 ConsentContext for the session; absent ⇒ adapter fails closed (INV-A4). */
  consent?: ConsentContext;
}

export function runIntel(
  session: string,
  bus: SessionEventBus,
  gateway: LlmGateway,
  opts: RunIntelOptions = {},
): RunIntelHandle {
  const index = new ProvenanceIndex();
  const store = new InMemoryArtifactStore();
  const deltaIndex = new DeltaIndex();

  /**
   * Phase-0 re-extraction verdict (INV-8): a superseded segment's cards are
   * `gone` — heuristic extraction has no way to re-ground them, so we retract
   * (un-render) rather than rewrite. The seam owns the propagation; we only
   * supply the verdict.
   */
  const reExtract: ReExtractor = (_oldSeg, _newSeg, affected) => {
    const perCard: Record<string, 'unchanged' | 'changed' | 'gone'> = {};
    for (const id of affected.conceptCardIds) perCard[id] = 'gone';
    return { perCard };
  };

  /**
   * Publish one F02 artifact; returns the bus seq it was assigned. `tenant` is
   * threaded explicitly because `kg_delta` is session-scoped and carries no
   * tenant_id — the routing envelope still needs one.
   */
  const publish = (payload: F02Payload, tenant: string): number => {
    const seq = bus.nextSeq(session, 'f02');
    const base: F02Envelope = {
      schema_version: '1.0.0',
      message_type: payload.message_type as F02MessageType,
      session_id: session,
      tenant_id: tenant,
      seq,
      ts_emit: TS_EMIT,
      producer: 'intel-worker',
      trace_id: `trace_${session}_f02_${seq}`,
    };
    bus.publish(session, { ...base, ...payload } as F02Out);
    return seq;
  };

  // queue of finals to process (kept tiny; adapt+extract are async on gateway).
  let chain: Promise<void> = Promise.resolve();

  const onEnvelope = (env: Envelope): void => {
    const seg = asTranscriptSegment(env);
    if (!seg) return; // F02 echoes / non-transcript F01 — ignore.
    if (!seg.is_final) return; // CT-INT-6: partials never trigger extraction.

    // adapt() is the ONLY place raw F01 fields are read (D16 / INV-A*).
    const input = adapt(seg, opts.consent);

    const tenant = seg.tenant_id;

    // A self-supersede (`supersedes === segment_id`) is a partial being finalized
    // in place (F01 §3.4): it closes the in-flight segment and carries no
    // cross-segment correction, so it must extract like any other final. Only a
    // supersede naming a DIFFERENT, already-extracted segment is a correction that
    // drives the INV-8 propagation seam.
    const isCorrection = seg.supersedes !== null && seg.supersedes !== seg.segment_id;

    // Serialize per-segment work so delta_seq stays monotonic (CT-INT-4).
    chain = chain.then(async () => {
      if (isCorrection) {
        // INV-8: a correction arrived — propagate via the seam, publish retractions.
        const result = propagateSupersede(seg, index, store, reExtract);
        for (const card of result.retracted) {
          store.putCard(card);
          publish({ message_type: 'concept_card', card }, tenant);
        }
        for (const card of result.reEmitted) {
          publish({ message_type: 'concept_card', card }, tenant);
        }
        // Map delta_seq → bus Position (the F02 seq string) for the resync seam.
        const dseq = publish({ message_type: 'kg_delta', delta: result.kgDelta }, tenant);
        deltaIndex.record(result.kgDelta.delta_seq, String(dseq));
        return;
      }

      const { cards, insights, kgDelta } = await extractFromFinal(
        input,
        gateway,
        store.nextDeltaSeq(),
      );
      for (const card of cards) {
        store.putCard(card);
        index.recordCard(card); // provenance for a later supersede (INV-8).
        publish({ message_type: 'concept_card', card }, tenant);
      }
      for (const insight of insights) {
        publish({ message_type: 'insight_item', insight }, tenant);
      }
      const dseq = publish({ message_type: 'kg_delta', delta: kgDelta }, tenant);
      deltaIndex.record(kgDelta.delta_seq, String(dseq));
    });
  };

  const unsub = bus.subscribe(session, opts.fromSeq ?? 0, onEnvelope);

  return {
    stop: unsub,
    drain: () => chain,
    index,
    store,
    deltaIndex,
  };
}

