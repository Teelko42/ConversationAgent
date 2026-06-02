import { describe, it, expect } from 'vitest';
import {
  AudioFrameSchema,
  TranscriptSegmentSchema,
  TENANT,
  SESSION,
  type AudioFrame,
  type TranscriptSegment,
} from '@aizen/contracts';
import { InMemorySessionBus } from '@aizen/edge-gateway';
import { StubSttProvider, runStt } from './index.js';

/**
 * Local AudioFrame builder — Lane B (capture) is the real producer; here we mint
 * valid frames directly so Lane C tests stand alone (PLAN: depends only on
 * @aizen/contracts + the bus). All timestamps are fixed integers (DETERMINISM).
 */
function makeAudioFrame(over: Partial<AudioFrame> = {}): AudioFrame {
  return {
    schema_version: '1.0.0',
    tenant_id: TENANT,
    session_id: SESSION,
    seq: 0,
    producer_id: 'capture-1',
    emitted_at: 1748707201000000,
    start_ms: 0,
    duration_ms: 20,
    session_start_at: 1748706943000000,
    codec: 'pcm_s16le',
    sample_rate_hz: 16000,
    channels: 1,
    samples: 320,
    payload: null,
    payload_ref: null,
    source: {
      kind: 'mic',
      platform: 'web',
      meeting_provider: null,
      channel_role: 'local_participant',
      participant_hint: null,
    },
    consent: { mode: 'store_audio', consent_id: 'c_88', redaction_pending: false },
    ...over,
  };
}

/** A speech frame at media-clock offset `i*20ms` (320 samples @ 16kHz / 20ms). */
const speechFrame = (i: number): AudioFrame =>
  makeAudioFrame({ start_ms: i * 20, samples: 320 });
/** An endpoint (silence) frame — `samples:0` — that closes the utterance. */
const silenceFrame = (i: number): AudioFrame =>
  makeAudioFrame({ start_ms: i * 20, samples: 0, duration_ms: 0 });

/** Sanity: our local builder really does produce valid AudioFrames. */
it('fixture: makeAudioFrame validates against AudioFrameSchema', () => {
  expect(AudioFrameSchema.safeParse(makeAudioFrame()).success).toBe(true);
});

describe('Lane C — stub STT provider (CT-STT-*)', () => {
  it('CT-STT-1: partial→final lifecycle — ≥1 is_final:false then a terminal is_final:true', () => {
    const p = new StubSttProvider({ wordsPerUtterance: 3 });
    const segs: TranscriptSegment[] = [
      ...p.transcribe(speechFrame(0)),
      ...p.transcribe(speechFrame(1)),
      ...p.transcribe(speechFrame(2)),
    ];
    const partials = segs.filter((s) => !s.is_final);
    const finals = segs.filter((s) => s.is_final);
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(finals.length).toBe(1);
    // the final is the last thing emitted for the utterance.
    expect(segs.at(-1)!.is_final).toBe(true);
  });

  it('CT-STT-2: rev strictly increments across a segment’s revisions', () => {
    const p = new StubSttProvider({ wordsPerUtterance: 3 });
    const segs: TranscriptSegment[] = [
      ...p.transcribe(speechFrame(0)),
      ...p.transcribe(speechFrame(1)),
      ...p.transcribe(speechFrame(2)),
    ];
    // all revisions belong to one utterance (one segment_id).
    const ids = new Set(segs.map((s) => s.segment_id));
    expect(ids.size).toBe(1);
    const revs = segs.map((s) => s.rev);
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i]!).toBeGreaterThan(revs[i - 1]!);
    }
    // the final carries the highest rev.
    expect(segs.at(-1)!.rev).toBe(Math.max(...revs));
  });

  it('CT-STT-3: the final’s supersedes points at the partial it replaces', () => {
    const p = new StubSttProvider({ wordsPerUtterance: 2 });
    const segs: TranscriptSegment[] = [
      ...p.transcribe(speechFrame(0)),
      ...p.transcribe(speechFrame(1)),
    ];
    const final = segs.find((s) => s.is_final)!;
    const lastPartial = [...segs].reverse().find((s) => !s.is_final)!;
    expect(final.supersedes).not.toBeNull();
    // §3.4: the final replaces the in-flight (partial) segment of the same id.
    expect(final.supersedes).toBe(lastPartial.segment_id);
    expect(final.rev).toBeGreaterThan(lastPartial.rev);
    // partials never supersede.
    expect(segs.filter((s) => !s.is_final).every((s) => s.supersedes === null)).toBe(true);
  });

  it('CT-STT-4: every segment validates; speaker + consent blocks well-formed', () => {
    const p = new StubSttProvider({ wordsPerUtterance: 3 });
    const segs: TranscriptSegment[] = [
      ...p.transcribe(speechFrame(0)),
      ...p.transcribe(speechFrame(1)),
      ...p.transcribe(speechFrame(2)),
      ...p.transcribe(silenceFrame(3)),
    ];
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      expect(TranscriptSegmentSchema.safeParse(s).success).toBe(true);
      expect(s.speaker.speaker_id).toBeTruthy();
      expect(s.speaker.display_name).toBeTruthy();
      expect(s.consent.consent_id).toBe('c_88');
      expect(['high', 'medium', 'low']).toContain(s.confidence_band);
      expect(s.end_ms).toBeGreaterThanOrEqual(s.start_ms);
    }
  });

  it('CT-STT-4b: a silence frame closes an in-flight utterance with a final', () => {
    const p = new StubSttProvider({ wordsPerUtterance: 10 }); // never auto-finalizes
    const segs: TranscriptSegment[] = [
      ...p.transcribe(speechFrame(0)),
      ...p.transcribe(speechFrame(1)),
      ...p.transcribe(silenceFrame(2)),
    ];
    expect(segs.filter((s) => s.is_final)).toHaveLength(1);
    expect(segs.at(-1)!.is_final).toBe(true);
  });
});

describe('Lane C — runStt over the bus (CT-STT-5)', () => {
  it('CT-STT-5: published in seq order; seq assigned by the bus', () => {
    const bus = new InMemorySessionBus();
    const handle = runStt(SESSION, bus, new StubSttProvider({ wordsPerUtterance: 3 }));

    // Capture-side: publish frames one at a time, each with a bus-assigned seq.
    // The worker's subscriber fires synchronously inside publish, so each frame's
    // transcripts are seq'd immediately after that frame.
    for (let i = 0; i < 3; i++) {
      const seq = bus.nextSeq(SESSION, 'f01');
      bus.publish(SESSION, { ...speechFrame(i), seq });
    }
    handle.stop();

    const log = bus.history(SESSION);
    // seq is contiguous from 0 and strictly increasing across the whole F01 log.
    const seqs = log.map((e) => e.seq);
    expect(seqs).toEqual([...seqs.keys()]); // [0,1,2,...] contiguous
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }

    // the published transcripts (envelopes with is_final present) carry bus seqs.
    const transcripts = log.filter(
      (e): e is TranscriptSegment => !('message_type' in e) && 'is_final' in e,
    );
    expect(transcripts.length).toBeGreaterThan(0);
    expect(transcripts.some((t) => t.is_final)).toBe(true);
    // each transcript's seq matches its position in the ordered log (BD-01).
    for (const t of transcripts) {
      expect(t.seq).toBe(log.indexOf(t));
    }
  });

  it('CT-STT-5b: stop() detaches — no further transcripts after stop', () => {
    const bus = new InMemorySessionBus();
    const handle = runStt(SESSION, bus, new StubSttProvider({ wordsPerUtterance: 3 }));
    handle.stop();

    const seq = bus.nextSeq(SESSION, 'f01');
    bus.publish(SESSION, { ...speechFrame(0), seq });

    const transcripts = bus
      .history(SESSION)
      .filter((e) => !('message_type' in e) && 'is_final' in e);
    expect(transcripts).toHaveLength(0); // only the frame is on the log
  });
});
