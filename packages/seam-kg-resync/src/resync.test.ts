import { describe, it, expect, vi } from 'vitest';
import {
  makeKgDelta,
  SESSION,
  TENANT,
  type KgDelta,
  type KgSnapshot,
  type Position,
} from '@aizen/contracts';
import {
  DeltaIndex,
  detectGap,
  resolveResync,
  computeContentHash,
  type ResyncBus,
  type SnapshotStore,
} from './index.js';

const base = { session_id: SESSION, tenant_id: TENANT, requester: 'f03.client@1' };

function busFrom(map: Record<Position, KgDelta[]>): ResyncBus {
  return { readFrom: (pos) => map[pos] ?? [] };
}

function snapshot(upToDeltaSeq: number, position: Position): KgSnapshot {
  return {
    message_type: 'kg_snapshot',
    schema_version: 'f02.contracts/v1',
    session_id: SESSION,
    tenant_id: TENANT,
    snapshot_id: 'kgs_1',
    up_to_delta_seq: upToDeltaSeq,
    up_to_position: position,
    generated_at_us: 1,
    node_count: 0,
    edge_count: 0,
    nodes: [],
    edges: [],
    content_hash: computeContentHash([], []),
    consent_class: 'standard',
  };
}

describe('Seam C — kg_delta resync (CT-C*)', () => {
  it('CT-C1: gap detection builds a resync request keyed on delta_seq', () => {
    const req = detectGap(base, 408, 412, 200);
    expect(req).not.toBeNull();
    expect(req!.reason).toBe('delta_seq_gap');
    expect(req!.last_applied_delta_seq).toBe(408);
    expect(req!.gap).toEqual({ missing_from: 409, observed: 412 });
    // contiguous delivery is NOT a gap
    expect(detectGap(base, 408, 409, 200)).toBeNull();
  });

  it('CT-C2: small gap → translate delta_seq via DeltaIndex, replay by Position', () => {
    const idx = new DeltaIndex();
    idx.record(409, 'pos-409');
    const bus = busFrom({
      'pos-409': [makeKgDelta({ delta_seq: 409 }), makeKgDelta({ delta_seq: 410 }), makeKgDelta({ delta_seq: 411 })],
    });
    const snapshots: SnapshotStore = {
      latestAtOrAbove: () => undefined,
      materialize: () => snapshot(0, 'pos-0'),
    };

    const req = detectGap(base, 408, 412, 200)!;
    const res = resolveResync(req, idx, bus, snapshots);

    expect(res.mode).toBe('replay'); // the delta_seq↔Position mapping worked (H-9 core)
    expect(res.deltas.map((d) => d.delta_seq)).toEqual([409, 410, 411]);
  });

  it('CT-C3: cold start → serve latest snapshot + tail', () => {
    const idx = new DeltaIndex();
    const bus = busFrom({ 'pos-405': [makeKgDelta({ delta_seq: 406 })] });
    const snapshots: SnapshotStore = {
      latestAtOrAbove: () => snapshot(405, 'pos-405'),
      materialize: () => snapshot(0, 'pos-0'),
    };

    const req = detectGap(base, null, 410, 200)!; // cold start
    const res = resolveResync(req, idx, bus, snapshots);

    expect(res.mode).toBe('snapshot+tail');
    expect(res.snapshot?.up_to_delta_seq).toBe(405);
    expect(res.deltas.map((d) => d.delta_seq)).toEqual([406]);
  });

  it('CT-C4: gap larger than max_replay → snapshot+tail, not replay', () => {
    const idx = new DeltaIndex();
    idx.record(11, 'pos-11'); // index has it, but the gap is too big to replay
    const bus = busFrom({ 'pos-10': [makeKgDelta({ delta_seq: 11 })] });
    const snapshots: SnapshotStore = {
      latestAtOrAbove: () => snapshot(10, 'pos-10'),
      materialize: () => snapshot(0, 'pos-0'),
    };

    const req = detectGap(base, 10, 500, 200)!; // gap_size 489 > 200
    const res = resolveResync(req, idx, bus, snapshots);
    expect(res.mode).toBe('snapshot+tail');
  });

  it('CT-C5: content_hash recomputes identically (convergence guard)', () => {
    const snap = snapshot(405, 'pos-405');
    expect(computeContentHash(snap.nodes, snap.edges)).toBe(snap.content_hash);
  });

  it('CT-C6: cold start with no checkpoint → F02 materialize() is invoked', () => {
    const idx = new DeltaIndex();
    const bus = busFrom({ 'pos-0': [] });
    const materialize = vi.fn(() => snapshot(0, 'pos-0'));
    const snapshots: SnapshotStore = {
      latestAtOrAbove: () => undefined, // no fresh snapshot exists
      materialize,
    };

    const req = detectGap(base, null, 5, 200)!;
    const res = resolveResync(req, idx, bus, snapshots);

    expect(materialize).toHaveBeenCalledOnce();
    expect(res.mode).toBe('snapshot+tail');
  });
});
