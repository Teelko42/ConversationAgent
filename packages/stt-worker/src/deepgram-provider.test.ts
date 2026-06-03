import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TranscriptSegment } from '@aizen/contracts';
import { DeepgramSttProvider, type DeepgramLikeSocket } from './index.js';

/** A controllable fake of the Deepgram live socket. */
function makeFakeSocket() {
  const handlers: Record<string, (arg: unknown) => void> = {};
  let keepAlives = 0;
  const socket = {
    on: (ev: string, cb: (arg: unknown) => void) => {
      handlers[ev] = cb;
    },
    sendMedia: () => {},
    sendCloseStream: () => {},
    sendKeepAlive: () => {
      keepAlives += 1;
    },
    close: () => {},
    waitForOpen: async () => {},
  } as unknown as DeepgramLikeSocket;
  return {
    socket,
    emit: (m: unknown) => handlers['message']?.(m),
    /** Simulate Deepgram (or the network) closing the live socket. */
    emitClose: () => handlers['close']?.({ code: 1011 }),
    /** How many KeepAlive frames the heartbeat has sent. */
    keepAliveCount: () => keepAlives,
  };
}

/** Build a Deepgram `Results` message. */
function results(
  transcript: string,
  opts: { is_final?: boolean; speech_final?: boolean; start?: number; duration?: number } = {},
) {
  return {
    type: 'Results',
    start: opts.start ?? 0,
    duration: opts.duration ?? 0.5,
    is_final: opts.is_final ?? false,
    speech_final: opts.speech_final ?? false,
    channel: {
      alternatives: [{ transcript, confidence: opts.is_final ? 0.95 : 0.6, words: [] }],
    },
  };
}

describe('DeepgramSttProvider — F01 lifecycle mapping (§3.4)', () => {
  it('emits growing partials then a self-superseding final per utterance', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({ apiKey: 'x', connect: async () => fake.socket });

    const segs: TranscriptSegment[] = [];
    await provider.open({ session_id: 's-uuid', tenant_id: 't-uuid' }, (s) => segs.push(s));

    fake.emit(results('so the', { is_final: false }));
    fake.emit(
      results('so the quarterly ARR', { is_final: true, speech_final: true, duration: 1.0 }),
    );

    expect(segs).toHaveLength(2);

    const [partial, final] = segs;
    expect(partial!.is_final).toBe(false);
    expect(partial!.rev).toBe(1);
    expect(partial!.text).toBe('so the');
    expect(partial!.supersedes).toBeNull();

    expect(final!.is_final).toBe(true);
    expect(final!.rev).toBe(2);
    expect(final!.text).toBe('so the quarterly ARR');
    expect(final!.segment_id).toBe(partial!.segment_id); // same utterance
    expect(final!.supersedes).toBe(final!.segment_id); // in-place finalization
    expect(final!.confidence_band).toBe('high');
  });

  it('starts a new segment_id for the next utterance', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({ apiKey: 'x', connect: async () => fake.socket });
    const segs: TranscriptSegment[] = [];
    await provider.open({ session_id: 's-uuid', tenant_id: 't-uuid' }, (s) => segs.push(s));

    fake.emit(results('first', { is_final: true, speech_final: true }));
    fake.emit(results('second', { is_final: true, speech_final: true }));

    const finals = segs.filter((s) => s.is_final);
    expect(finals).toHaveLength(2);
    expect(finals[0]!.segment_id).not.toBe(finals[1]!.segment_id);
  });
});

describe('DeepgramSttProvider — KeepAlive heartbeat (socket survives recording pauses)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends KeepAlive frames on a cadence below the idle-close window', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({
      apiKey: 'x',
      connect: async () => fake.socket,
      keepAliveMs: 5000,
    });

    const session = await provider.open({ session_id: 's-uuid', tenant_id: 't-uuid' }, () => {});
    expect(fake.keepAliveCount()).toBe(0);

    // A 30 s recording pause would idle-close Deepgram (~10 s) without heartbeats;
    // here the heartbeat fires every 5 s so the socket stays open the whole time.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.keepAliveCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(25000);
    expect(fake.keepAliveCount()).toBe(6);

    await session.finish();
  });

  it('stops the heartbeat after finish() so a closed session leaks no timer', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({
      apiKey: 'x',
      connect: async () => fake.socket,
      keepAliveMs: 5000,
    });
    const session = await provider.open({ session_id: 's-uuid', tenant_id: 't-uuid' }, () => {});

    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.keepAliveCount()).toBe(1);

    await session.finish();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fake.keepAliveCount()).toBe(1); // no further frames after finish
  });

  it('stops the heartbeat when the socket closes on its own', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({
      apiKey: 'x',
      connect: async () => fake.socket,
      keepAliveMs: 5000,
    });
    await provider.open({ session_id: 's-uuid', tenant_id: 't-uuid' }, () => {});

    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.keepAliveCount()).toBe(1);

    fake.emitClose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fake.keepAliveCount()).toBe(1); // heartbeat cleared on close
  });

  it('honours keepAliveMs:0 to disable the heartbeat entirely', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({
      apiKey: 'x',
      connect: async () => fake.socket,
      keepAliveMs: 0,
    });
    const session = await provider.open({ session_id: 's-uuid', tenant_id: 't-uuid' }, () => {});

    await vi.advanceTimersByTimeAsync(60000);
    expect(fake.keepAliveCount()).toBe(0);

    await session.finish();
  });
});
