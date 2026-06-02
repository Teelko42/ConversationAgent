/**
 * @aizen/session-conductor — Lane E (F03·T7). The per-session orchestrator: it
 * constructs ONE `InMemorySessionBus` (BD-01), gates ingress on consent
 * (`ConsentGate`, fail-closed), then wires the A→D worker chain over that single
 * bus — `startCapture` (Lane B) → `runStt` (Lane C) → `runIntel` (Lane D) — so a
 * fixture clip flows end to end. This is the only lane that imports the others'
 * public exports (BD-04); it reuses them as-is and reinvents nothing.
 *
 * Failure-recovery stub (F03·T7 placeholder): each worker is started inside a
 * try/catch. A throw while wiring a worker is caught and logged, and the session
 * continues with whatever workers did start — the Phase-0 stand-in for the real
 * recovery ladder (restart/resync). It never tears the whole session down.
 *
 * DETERMINISM: the conductor calls no wall-clock and no RNG; the only timestamps
 * in the spine are the fixed integer constants the workers already carry
 * (mirroring fixtures.ts). Re-running on a fixture clip is reproducible.
 */
import type { CaptureSource } from '@aizen/capture';
import type { ConsentContext } from '@aizen/contracts';
import type { SessionEventBus } from '@aizen/edge-gateway';
import type { LlmGateway } from '@aizen/llm-gateway';
import type { SttProvider } from '@aizen/stt-worker';

import { InMemorySessionBus, ConsentGate } from '@aizen/edge-gateway';
import { MockClipSource, startCapture } from '@aizen/capture';
import { StubSttProvider, runStt } from '@aizen/stt-worker';
import { runIntel, type RunIntelHandle } from '@aizen/intel-worker';

/** Per-worker teardown handles (every Lane A–D handle exposes `stop()`). */
interface Stoppable {
  stop(): void;
}

/** Options for one `start` call — the wiring inputs A–D need. */
export interface ConductorStartOptions {
  /** F04 consent for the session. ABSENT ⇒ ingress denied (fail-closed, D20). */
  consent?: ConsentContext;
  /** D15 LLM gateway the intel worker invokes (provider + cost meter pre-built). */
  gateway: LlmGateway;
  /** Capture source (default: the deterministic fixture clip, BD-03). */
  source?: CaptureSource;
  /** STT provider (default: the deterministic stub, BD-03). */
  stt?: SttProvider;
}

/** Live per-session wiring the conductor holds so `stop()` can tear it down. */
interface SessionWiring {
  bus: InMemorySessionBus;
  workers: Stoppable[];
  intel: RunIntelHandle;
}

/**
 * Orchestrates the Phase-0 spine for one or more sessions. `start` builds the
 * bus, gates on consent, and wires the worker chain; `bus(session)` exposes that
 * session's bus for rendering (web-client) and inspection; `stop` detaches every
 * worker. `drain(session)` awaits the intel worker's in-flight async work (the
 * gateway is async) so tests can assert on a settled render.
 */
export class SessionConductor {
  private readonly gate = new ConsentGate();
  private readonly sessions = new Map<string, SessionWiring>();

  /**
   * Start the spine for `session`. Ingress is consent-gated FIRST (D18/D20): if
   * the `ConsentGate` refuses (absent / not-all-cleared context) we throw before
   * any bus or worker exists — nothing enters the bus without affirmative
   * consent. On admit, one bus is built and capture→stt→intel are wired over it,
   * each behind the failure-recovery try/catch.
   */
  start(session: string, opts: ConductorStartOptions): SessionEventBus {
    if (!this.gate.admit(session, opts.consent)) {
      // fail-closed: refuse the whole session (INV-A4 / D20). No bus is created.
      throw new Error(`consent refused for session ${session} (fail-closed)`);
    }

    const bus = new InMemorySessionBus();
    const workers: Stoppable[] = [];

    // Lane D first so it subscribes from seq 0 and sees every later F01 envelope.
    const intel = runIntel(session, bus, opts.gateway, { consent: opts.consent });
    workers.push(intel);

    // Lane C: AudioFrame → TranscriptSegment (stub provider by default). A final
    // marks the in-place finalization of its own partial via
    // `supersedes === segment_id` (F01 §3.4); Lane D's runIntel treats that as a
    // normal final (only a DIFFERENT-id supersede is a correction), so the
    // provider is wired straight through with no reconciliation shim.
    this.guarded(session, 'stt-worker', () => {
      workers.push(runStt(session, bus, opts.stt ?? new StubSttProvider()));
    });

    // Lane B: source → AudioFrame (the fixture clip by default). Started LAST so
    // the STT + intel subscribers are already attached when frames flow.
    this.guarded(session, 'capture', () => {
      const source = opts.source ?? new MockClipSource();
      workers.push(startCapture(session, source, bus));
    });

    this.sessions.set(session, { bus, workers, intel });
    return bus;
  }

  /** The bus for `session`. Throws if the session was never started. */
  bus(session: string): SessionEventBus {
    const w = this.sessions.get(session);
    if (!w) throw new Error(`no live session ${session}`);
    return w.bus;
  }

  /**
   * Await the intel worker's in-flight extraction/propagation chain for
   * `session` (the LLM gateway is async). After this resolves the bus history is
   * settled and the render is final.
   */
  drain(session: string): Promise<void> {
    const w = this.sessions.get(session);
    if (!w) return Promise.resolve();
    return w.intel.drain();
  }

  /** Detach every worker for `session` and forget it. Idempotent. */
  stop(session: string): void {
    const w = this.sessions.get(session);
    if (!w) return;
    for (const worker of w.workers) {
      // failure-recovery: a throw in one teardown must not block the others.
      this.guarded(session, 'stop', () => worker.stop());
    }
    this.sessions.delete(session);
  }

  /**
   * Run `fn` inside the F03·T7 failure-recovery stub: a throw is caught and
   * logged, and the session continues. The Phase-0 placeholder for the real
   * restart/resync ladder — it never propagates a worker fault to the session.
   */
  private guarded(session: string, who: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // eslint-disable-next-line no-console -- Phase-0 recovery is log-and-continue.
      console.error(`[conductor] ${who} faulted on ${session}; continuing:`, err);
    }
  }
}
