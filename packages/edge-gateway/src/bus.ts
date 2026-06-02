import type { F01Envelope, F02Envelope } from '@aizen/contracts';
import { SeqAssigner } from './seq.js';

/**
 * BD-01 — the per-session event backbone (run 20260601-phase0-spine).
 *
 * One append-only, **seq-ordered** log + fan-out per session: the in-process
 * Phase-0 stand-in for Kinesis (D13 — MSK arrives at Year-1). Every inter-lane
 * data flow rides this; lanes never import each other's internals, only this
 * interface + `@aizen/contracts`.
 *
 * Lane A owns the concrete `InMemorySessionBus implements SessionEventBus`
 * (filled in `src/index.ts` / a sibling file). B/C/D/E code against the
 * interface only.
 */

/** Either canonical envelope class carried on the bus. */
export type Envelope = F01Envelope | F02Envelope;

/** Seq-assignment class: F01 (audio/transcript) vs F02 (intelligence). */
export type EnvelopeClass = 'f01' | 'f02';

export interface SessionEventBus {
  /** Next monotonic seq for a session + class — the doc-05 "seq assigner". */
  nextSeq(session: string, cls: EnvelopeClass): number;
  /** Append an already-seq'd envelope; rejects non-monotonic / duplicate seq. */
  publish(session: string, env: Envelope): void;
  /** Replay from `fromSeq` (inclusive) then stream live, in seq order. Returns unsubscribe. */
  subscribe(session: string, fromSeq: number, fn: (env: Envelope) => void): () => void;
  /** Full ordered history for a session (inspection / tests). */
  history(session: string): readonly Envelope[];
}

/** F02 envelopes carry an explicit `message_type`; F01 envelopes do not. */
function classOf(env: Envelope): EnvelopeClass {
  return 'message_type' in env ? 'f02' : 'f01';
}

/** Per-session mutable state: the ordered log, live subscribers, expected seqs. */
interface SessionState {
  /** append-only, append-ordered log (publish order == seq order, per class). */
  log: Envelope[];
  /** live fan-out callbacks. */
  subscribers: Set<(env: Envelope) => void>;
  /** next seq each class must publish (strict-next; gaps are the resync seam's job). */
  expected: Map<EnvelopeClass, number>;
}

/**
 * In-process `SessionEventBus` (BD-01) — the Phase-0 stand-in for Kinesis.
 *
 * One append-only, seq-ordered log per session plus a live fan-out. `publish`
 * is strict-next per class: an envelope is accepted only if its `seq` equals the
 * next expected seq for its class (`nextSeq` would have handed it that value).
 * Out-of-order / duplicate seqs are REJECTED (they throw) — gap recovery is the
 * resync seam's concern, not the bus's.
 *
 * `subscribe(session, fromSeq, fn)` replays the existing log from `fromSeq`
 * (inclusive, in log order) then streams every subsequent publish live. The
 * returned function unsubscribes.
 */
export class InMemorySessionBus implements SessionEventBus {
  private readonly seqAssigner = new SeqAssigner();
  private readonly sessions = new Map<string, SessionState>();

  private session(session: string): SessionState {
    let s = this.sessions.get(session);
    if (!s) {
      s = { log: [], subscribers: new Set(), expected: new Map() };
      this.sessions.set(session, s);
    }
    return s;
  }

  nextSeq(session: string, cls: EnvelopeClass): number {
    return this.seqAssigner.next(session, cls);
  }

  publish(session: string, env: Envelope): void {
    const s = this.session(session);
    const cls = classOf(env);
    const expected = s.expected.get(cls) ?? 0;
    if (env.seq !== expected) {
      // strict-next: reject duplicates AND out-of-order (forward gaps too).
      throw new Error(
        `seq violation on ${session}/${cls}: expected ${expected}, got ${env.seq}`,
      );
    }
    s.expected.set(cls, expected + 1);
    s.log.push(env);
    // fan out live to current subscribers (snapshot to tolerate unsubscribe-in-cb).
    for (const fn of [...s.subscribers]) fn(env);
  }

  subscribe(
    session: string,
    fromSeq: number,
    fn: (env: Envelope) => void,
  ): () => void {
    const s = this.session(session);
    // replay first, in log (== seq) order, from fromSeq inclusive.
    for (const env of s.log) {
      if (env.seq >= fromSeq) fn(env);
    }
    s.subscribers.add(fn);
    return () => {
      s.subscribers.delete(fn);
    };
  }

  history(session: string): readonly Envelope[] {
    return this.session(session).log;
  }
}
