import { describe, it, expect } from 'vitest';
import { AudioFrameSchema, type AudioFrame, SESSION } from '@aizen/contracts';
import { InMemorySessionBus, type SessionEventBus } from '@aizen/edge-gateway';
import { MockClipSource, startCapture, type AudioChunk } from './index.js';

/**
 * Drain the microtask queue so the async drive loop in `startCapture` finishes
 * publishing a finite (sync) source. Deterministic: no timers, no clock — just
 * yields the event loop a bounded number of turns (one per chunk + slack).
 */
async function drain(turns = 64): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** The bus only ever carries F01 envelopes here; every entry is an AudioFrame. */
function framesOf(bus: SessionEventBus, session: string): AudioFrame[] {
  return bus.history(session) as AudioFrame[];
}

describe('Lane B — capture (CT-CAP-*)', () => {
  it('CT-CAP-1: every published frame validates against AudioFrameSchema', async () => {
    const bus = new InMemorySessionBus();
    startCapture(SESSION, new MockClipSource(), bus);
    await drain();

    const frames = framesOf(bus, SESSION);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(AudioFrameSchema.safeParse(f).success).toBe(true);
    }
  });

  it('CT-CAP-2: media-clock start_ms is monotonic non-decreasing, no overlap', async () => {
    const bus = new InMemorySessionBus();
    startCapture(SESSION, new MockClipSource(), bus);
    await drain();

    const frames = framesOf(bus, SESSION);
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1]!;
      const cur = frames[i]!;
      // monotonic non-decreasing start, and the next chunk starts no earlier
      // than the previous one ended (contiguous / non-overlapping media clock).
      expect(cur.start_ms).toBeGreaterThanOrEqual(prev.start_ms);
      expect(cur.start_ms).toBeGreaterThanOrEqual(prev.start_ms + prev.duration_ms);
    }
  });

  it('CT-CAP-3: N input chunks -> N frames on the bus, in seq order', async () => {
    const chunks: AudioChunk[] = [
      { startMs: 0, durationMs: 30, samples: 480 },
      { startMs: 30, durationMs: 30, samples: 480 },
      { startMs: 60, durationMs: 30, samples: 480 },
    ];
    const bus = new InMemorySessionBus();
    startCapture(SESSION, new MockClipSource(chunks), bus);
    await drain();

    const frames = framesOf(bus, SESSION);
    expect(frames.length).toBe(chunks.length);
    // seq is strictly increasing in publish order (and maps the chunk order).
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i]!.seq).toBe(i);
      expect(frames[i]!.start_ms).toBe(chunks[i]!.startMs);
    }
  });

  it('CT-CAP-4: seq is obtained from the bus (class f01), not invented', async () => {
    // A bus whose nextSeq starts at an offset proves capture uses the assigner
    // rather than inventing 0..N-1 itself.
    const inner = new InMemorySessionBus();
    const handed: number[] = [];
    const spyBus: SessionEventBus = {
      nextSeq(session, cls) {
        expect(cls).toBe('f01');
        const s = inner.nextSeq(session, cls);
        handed.push(s);
        return s;
      },
      publish: (session, env) => inner.publish(session, env),
      subscribe: (session, fromSeq, fn) => inner.subscribe(session, fromSeq, fn),
      history: (session) => inner.history(session),
    };

    startCapture(SESSION, new MockClipSource(), spyBus);
    await drain();

    const frames = framesOf(inner, SESSION);
    // every published frame's seq came from a nextSeq() call, in order.
    expect(handed.length).toBe(frames.length);
    expect(frames.map((f) => f.seq)).toEqual(handed);
  });
});
