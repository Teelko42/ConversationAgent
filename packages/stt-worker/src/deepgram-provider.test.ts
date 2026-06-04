import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranscriptSegmentSchema, type TranscriptSegment } from '@aizen/contracts';
import { DeepgramSttProvider, type DeepgramLikeSocket } from './index.js';

/** A Deepgram diarized word. */
type DgWord = {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
  punctuated_word?: string;
};

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
  opts: {
    is_final?: boolean;
    speech_final?: boolean;
    start?: number;
    duration?: number;
    words?: DgWord[];
  } = {},
) {
  return {
    type: 'Results',
    start: opts.start ?? 0,
    duration: opts.duration ?? 0.5,
    is_final: opts.is_final ?? false,
    speech_final: opts.speech_final ?? false,
    channel: {
      alternatives: [{ transcript, confidence: opts.is_final ? 0.95 : 0.6, words: opts.words ?? [] }],
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

describe('DeepgramSttProvider — word-level speaker attribution (Speaker_Research.md §9.1/§9.4)', () => {
  it('populates per-word speaker_id and derives the segment speaker by duration majority', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({ apiKey: 'x', connect: async () => fake.socket });
    const segs: TranscriptSegment[] = [];
    // Real UUIDs so the emitted segment validates against the F01 envelope schema.
    await provider.open(
      { session_id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222' },
      (s) => segs.push(s),
    );

    // First (short) word is speaker 0; the rest (longer) is speaker 1 — a
    // mid-utterance speaker change the OLD mapper collapsed onto spk_1.
    fake.emit(
      results('hi yes absolutely', {
        is_final: true,
        speech_final: true,
        duration: 1.8,
        words: [
          { word: 'hi', start: 0, end: 0.2, confidence: 0.9, speaker: 0 },
          { word: 'yes', start: 0.2, end: 0.9, confidence: 0.9, speaker: 1 },
          { word: 'absolutely', start: 0.9, end: 1.8, confidence: 0.9, speaker: 1 },
        ],
      }),
    );

    const final = segs.find((s) => s.is_final)!;
    // The emitted segment is still contract-valid with the richer payload.
    expect(TranscriptSegmentSchema.safeParse(final).success).toBe(true);
    expect(final.words).toHaveLength(3);
    expect(final.words!.map((w) => w.speaker_id)).toEqual(['spk_1', 'spk_2', 'spk_2']);
    expect(final.words![0]).toMatchObject({ w: 'hi', start_ms: 0, end_ms: 200, speaker_id: 'spk_1' });
    // duration-weighted majority → spk_2, NOT the first word's spk_1 (the bug)
    expect(final.speaker.speaker_id).toBe('spk_2');
    expect(final.speaker.display_name).toBe('Speaker 2');
    expect(final.speaker.is_overlap).toBe(true);
    expect(final.speaker.speaker_confidence).toBeCloseTo(1.6 / 1.8, 5);
    expect(final.speaker.diarization_method).toBe('deepgram_online');
  });

  it('accumulates per-word diarization across multiple is_final chunks into the final', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({ apiKey: 'x', connect: async () => fake.socket });
    const segs: TranscriptSegment[] = [];
    await provider.open({ session_id: 's-uuid', tenant_id: 't-uuid' }, (s) => segs.push(s));

    fake.emit(
      results('hello there', {
        is_final: true,
        words: [
          { word: 'hello', start: 0, end: 0.4, confidence: 0.9, speaker: 0 },
          { word: 'there', start: 0.4, end: 0.8, confidence: 0.9, speaker: 0 },
        ],
      }),
    );
    fake.emit(
      results('friend', {
        is_final: true,
        words: [{ word: 'friend', start: 0.8, end: 1.2, confidence: 0.9, speaker: 0 }],
      }),
    );
    fake.emit(results('', { speech_final: true, start: 1.2, duration: 0 }));

    const final = segs.find((s) => s.is_final)!;
    expect(final.text).toBe('hello there friend');
    expect(final.words!.map((w) => w.w)).toEqual(['hello', 'there', 'friend']);
    expect(final.speaker.speaker_id).toBe('spk_1');
    expect(final.speaker.is_overlap).toBe(false);
  });

  it('honours a configurable diarization_method (per-track / refinement regimes)', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({
      apiKey: 'x',
      connect: async () => fake.socket,
      diarizationMethod: 'per_channel',
    });
    const segs: TranscriptSegment[] = [];
    await provider.open({ session_id: 's-uuid', tenant_id: 't-uuid' }, (s) => segs.push(s));

    fake.emit(
      results('hi', {
        is_final: true,
        speech_final: true,
        words: [{ word: 'hi', start: 0, end: 0.3, confidence: 0.9, speaker: 0 }],
      }),
    );
    const final = segs.find((s) => s.is_final)!;
    expect(final.speaker.diarization_method).toBe('per_channel');
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
