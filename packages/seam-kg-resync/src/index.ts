import { createHash } from 'node:crypto';
import type {
  KgDelta,
  KgSnapshot,
  KgResyncRequest,
  Position,
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
} from '@aizen/contracts';

/**
 * Seam C (doc 10 §3) — the `kg_delta` resync protocol C-7 left as a prose arrow.
 *
 * The missing link is the translation between F02's application-level `delta_seq`
 * and the bus's opaque `Position` (Kinesis SequenceNumber / Kafka offset). The
 * DeltaIndex is that translation; resolveResync is the decision tree (§3.5).
 */

// ---------------------------------------------------------------------------
// delta_seq ↔ Position index (doc 10 §3.2). Production: DynamoDB per session.
// ---------------------------------------------------------------------------
export class DeltaIndex {
  private readonly byDelta = new Map<number, Position>();

  record(deltaSeq: number, position: Position): void {
    this.byDelta.set(deltaSeq, position);
  }
  has(deltaSeq: number): boolean {
    return this.byDelta.has(deltaSeq);
  }
  resolve(deltaSeq: number): Position | undefined {
    return this.byDelta.get(deltaSeq);
  }
}

// ---------------------------------------------------------------------------
// Ports the resolver depends on (faked in tests; F04 in production)
// ---------------------------------------------------------------------------
export interface ResyncBus {
  /** ordered deltas from `position` (exclusive of the snapshot splice) to latest. */
  readFrom(position: Position): KgDelta[];
}
export interface SnapshotStore {
  /** newest checkpoint with up_to_delta_seq >= deltaSeq, if any. */
  latestAtOrAbove(deltaSeq: number): KgSnapshot | undefined;
  /** ask F02 to materialize a fresh snapshot now (cold start, no checkpoint). */
  materialize(): KgSnapshot;
}

export interface ResyncResponse {
  mode: 'replay' | 'snapshot+tail';
  snapshot?: KgSnapshot;
  deltas: KgDelta[];
}

// ---------------------------------------------------------------------------
// F03 side: detect a gap and build the request (doc 10 §3.4)
// ---------------------------------------------------------------------------
export function detectGap(
  base: { session_id: string; tenant_id: string; requester: string },
  lastApplied: number | null,
  observedDeltaSeq: number,
  maxReplay: number,
): KgResyncRequest | null {
  if (lastApplied === null) {
    return {
      message_type: 'kg_resync_request',
      ...base,
      last_applied_delta_seq: null,
      gap: null,
      reason: 'cold_start',
      max_replay: maxReplay,
    };
  }
  if (observedDeltaSeq <= lastApplied + 1) return null; // contiguous — no gap
  return {
    message_type: 'kg_resync_request',
    ...base,
    last_applied_delta_seq: lastApplied,
    gap: { missing_from: lastApplied + 1, observed: observedDeltaSeq },
    reason: 'delta_seq_gap',
    max_replay: maxReplay,
  };
}

// ---------------------------------------------------------------------------
// F04 side: resolve the request (the decision tree, doc 10 §3.5)
// ---------------------------------------------------------------------------
export function resolveResync(
  req: KgResyncRequest,
  deltaIndex: DeltaIndex,
  bus: ResyncBus,
  snapshots: SnapshotStore,
): ResyncResponse {
  const L = req.last_applied_delta_seq;
  const observed = req.gap?.observed ?? null;
  const gapSize = L !== null && observed !== null ? observed - L - 1 : Infinity;
  const canReplay =
    req.reason !== 'cold_start' &&
    L !== null &&
    gapSize <= req.max_replay &&
    deltaIndex.has(L + 1);

  if (canReplay) {
    // translate delta_seq (L+1) → Position, then replay by Position
    const from = deltaIndex.resolve(L + 1)!;
    return { mode: 'replay', deltas: bus.readFrom(from) };
  }

  // cold start / large gap / index miss → snapshot + tail
  const snap = snapshots.latestAtOrAbove(L ?? 0) ?? snapshots.materialize();
  const tail = bus.readFrom(snap.up_to_position);
  return { mode: 'snapshot+tail', snapshot: snap, deltas: tail };
}

// ---------------------------------------------------------------------------
// Content hash — convergence check after a resync (doc 10 §3.3)
// ---------------------------------------------------------------------------
export function computeContentHash(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
): string {
  const n = nodes.map((x) => `${x.id}:${x.revision}`).sort();
  const e = edges.map((x) => `${x.id}:${x.revision}`).sort();
  const canonical = JSON.stringify({ n, e });
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}
