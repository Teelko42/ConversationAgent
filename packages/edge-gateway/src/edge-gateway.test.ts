import { describe, it, expect } from 'vitest';
import {
  type F01Envelope,
  type F02Envelope,
  F01EnvelopeSchema,
  F02EnvelopeSchema,
  TENANT,
  SESSION,
  makeConsentContext,
} from '@aizen/contracts';
import { InMemorySessionBus } from './bus.js';
import { SeqAssigner } from './seq.js';
import { ConsentGate } from './consent-gate.js';

// Fixed (deterministic) wall-clock constants — mirrors fixtures.ts emitted_at /
// session_start_at; NO wall-clock or RNG anywhere in this suite.
const EMITTED_AT = 1748707201987000;
const TS_EMIT = 1748707202000000;
const SESSION_B = '33333333-3333-4333-8333-333333333333';

/** A valid F01 envelope (audio/transcript class) carrying a gateway-assigned seq. */
function f01(seq: number, session = SESSION): F01Envelope {
  const env: F01Envelope = {
    schema_version: '1.0.0',
    tenant_id: TENANT,
    session_id: session,
    seq,
    producer_id: 'stt-worker-3',
    emitted_at: EMITTED_AT,
  };
  // sanity: the envelopes we feed the bus are themselves contract-valid.
  expect(F01EnvelopeSchema.safeParse(env).success).toBe(true);
  return env;
}

/** A valid F02 envelope (intelligence class) carrying a gateway-assigned seq. */
function f02(seq: number, session = SESSION): F02Envelope {
  const env: F02Envelope = {
    schema_version: '1.0.0',
    message_type: 'concept_card',
    session_id: session,
    tenant_id: TENANT,
    seq,
    ts_emit: TS_EMIT,
    producer: 'intel-worker-1',
    trace_id: 'trace_eg',
  };
  expect(F02EnvelopeSchema.safeParse(env).success).toBe(true);
  return env;
}

describe('Lane A — edge-gateway SessionEventBus (CT-EG-*)', () => {
  it('CT-EG-1: nextSeq is monotonic per session+class, independent across sessions', () => {
    const bus = new InMemorySessionBus();
    // per (session, class) monotonic from 0
    expect(bus.nextSeq(SESSION, 'f01')).toBe(0);
    expect(bus.nextSeq(SESSION, 'f01')).toBe(1);
    expect(bus.nextSeq(SESSION, 'f01')).toBe(2);
    // class f02 is an independent counter on the same session
    expect(bus.nextSeq(SESSION, 'f02')).toBe(0);
    expect(bus.nextSeq(SESSION, 'f02')).toBe(1);
    // a different session is fully independent
    expect(bus.nextSeq(SESSION_B, 'f01')).toBe(0);
    expect(bus.nextSeq(SESSION, 'f01')).toBe(3);

    // SeqAssigner itself honours the same contract.
    const sa = new SeqAssigner();
    expect(sa.next(SESSION, 'f01')).toBe(0);
    expect(sa.peek(SESSION, 'f01')).toBe(1);
    expect(sa.next(SESSION, 'f02')).toBe(0);
  });

  it('CT-EG-2: publish rejects out-of-order / duplicate seq; accepts strict-next', () => {
    const bus = new InMemorySessionBus();
    bus.publish(SESSION, f01(0)); // first f01 must be seq 0
    bus.publish(SESSION, f01(1));
    // duplicate of last
    expect(() => bus.publish(SESSION, f01(1))).toThrow(/seq violation/);
    // forward gap (skips 2)
    expect(() => bus.publish(SESSION, f01(3))).toThrow(/seq violation/);
    // f02 has its own counter, also strict-next from 0
    expect(() => bus.publish(SESSION, f02(1))).toThrow(/seq violation/);
    bus.publish(SESSION, f02(0));
    bus.publish(SESSION, f01(2)); // resumes in order
    expect(bus.history(SESSION).map((e) => e.seq)).toEqual([0, 1, 0, 2]);
  });

  it('CT-EG-3: subscribe(fromSeq=0) replays full history in seq order, then live', () => {
    const bus = new InMemorySessionBus();
    bus.publish(SESSION, f01(0));
    bus.publish(SESSION, f01(1));

    const seen: number[] = [];
    const unsub = bus.subscribe(SESSION, 0, (env) => seen.push(env.seq));
    // replay happened synchronously on subscribe
    expect(seen).toEqual([0, 1]);

    // subsequent publishes stream live to the same subscriber
    bus.publish(SESSION, f01(2));
    expect(seen).toEqual([0, 1, 2]);

    unsub();
    bus.publish(SESSION, f01(3));
    expect(seen).toEqual([0, 1, 2]); // no delivery after unsubscribe
  });

  it('CT-EG-4: fan-out — N subscribers each see every event once, in order', () => {
    const bus = new InMemorySessionBus();
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    bus.subscribe(SESSION, 0, (env) => a.push(env.seq));
    bus.subscribe(SESSION, 0, (env) => b.push(env.seq));
    bus.subscribe(SESSION, 0, (env) => c.push(env.seq));

    bus.publish(SESSION, f01(0));
    bus.publish(SESSION, f01(1));
    bus.publish(SESSION, f01(2));

    expect(a).toEqual([0, 1, 2]);
    expect(b).toEqual([0, 1, 2]);
    expect(c).toEqual([0, 1, 2]);
  });

  it('CT-EG-5: ConsentGate.admit is fail-closed (false when ctx undefined), true when consented', () => {
    const gate = new ConsentGate();
    // absent context ⇒ denied (INV-A4); never invent "standard"/"consented".
    expect(gate.admit(SESSION, undefined)).toBe(false);
    // the golden ConsentContext has its one speaker `consented` ⇒ admitted.
    expect(gate.admit(SESSION, makeConsentContext())).toBe(true);
    // a refused speaker fails the whole session closed.
    expect(
      gate.admit(SESSION, makeConsentContext({ per_speaker: { spk_2: 'refused' } })),
    ).toBe(false);
    // an empty speaker set is not affirmative consent.
    expect(gate.admit(SESSION, makeConsentContext({ per_speaker: {} }))).toBe(false);
  });
});
