import { describe, it, expect } from 'vitest';
import { diarizeWords, type DiarWord } from './diarization.js';

const w = (word: string, start: number, end: number, speaker: number, confidence = 0.9): DiarWord => ({
  word,
  start,
  end,
  speaker,
  confidence,
});

describe('diarizeWords — per-word attribution + segment speaker (§9.1/§9.4)', () => {
  it('maps a clean single-speaker turn → spk_1, confidence 1.0, no overlap', () => {
    const d = diarizeWords([w('so', 0, 0.3, 0), w('the', 0.3, 0.6, 0), w('arr', 0.6, 1.0, 0)]);
    expect(d.speaker_id).toBe('spk_1');
    expect(d.display_name).toBe('Speaker 1');
    expect(d.speaker_confidence).toBe(1);
    expect(d.is_overlap).toBe(false);
    expect(d.speaker_count).toBe(1);
    expect(d.words).toHaveLength(3);
    // per-word contract shape: seconds → integer ms, own speaker_id
    expect(d.words[0]).toMatchObject({
      w: 'so',
      start_ms: 0,
      end_ms: 300,
      speaker_id: 'spk_1',
      is_domain_term: false,
      alt: null,
    });
  });

  it('FIXES THE BUG: a mid-utterance speaker change is NOT collapsed onto the first word', () => {
    // First (short) word is speaker 0; the rest (longer) is speaker 1.
    // The OLD mapper returned spk_1 (first word). Duration-weighted majority → spk_2.
    const words = [
      w('hi', 0, 0.2, 0),
      w('yes', 0.2, 0.9, 1),
      w('absolutely', 0.9, 1.8, 1),
    ];
    const d = diarizeWords(words);
    expect(d.speaker_id).toBe('spk_2'); // dominant by duration (1.6s vs 0.2s)
    expect(d.is_overlap).toBe(true); // words disagree on speaker
    expect(d.speaker_count).toBe(2);
    // per-word labels are preserved (the data the old code discarded)
    expect(d.words.map((x) => x.speaker_id)).toEqual(['spk_1', 'spk_2', 'spk_2']);
    // confidence = dominant share = 1.6 / 1.8
    expect(d.speaker_confidence).toBeCloseTo(1.6 / 1.8, 5);
  });

  it('derives speaker_confidence as the dominant speaker’s duration share', () => {
    // spk0: 0.6s, spk1: 0.4s → dominant spk_1 with 0.6 share.
    const d = diarizeWords([w('a', 0, 0.6, 0), w('b', 0.6, 1.0, 1)]);
    expect(d.speaker_id).toBe('spk_1');
    expect(d.speaker_confidence).toBeCloseTo(0.6, 5);
    expect(d.is_overlap).toBe(true);
  });

  it('breaks ties toward the earliest-appearing speaker (arrival order)', () => {
    // Equal duration; speaker 1 appears first → wins the tie.
    const d = diarizeWords([w('first', 0, 0.5, 1), w('second', 0.5, 1.0, 0)]);
    expect(d.speaker_id).toBe('spk_2'); // index 1 → spk_2
    expect(d.speaker_confidence).toBeCloseTo(0.5, 5);
  });

  it('falls back to word COUNT when every word has non-positive duration', () => {
    // Zero-length (garbled) timestamps: spk0 has 2 words, spk1 has 1.
    const d = diarizeWords([w('x', 1, 1, 0), w('y', 1, 1, 0), w('z', 1, 1, 1)]);
    expect(d.speaker_id).toBe('spk_1'); // 2 words vs 1
    expect(d.speaker_confidence).toBeCloseTo(2 / 3, 5);
    expect(d.is_overlap).toBe(true);
  });

  it('treats a missing speaker index as speaker 0', () => {
    const d = diarizeWords([{ word: 'hm', start: 0, end: 0.4, confidence: 0.8 }]);
    expect(d.speaker_id).toBe('spk_1');
    expect(d.words[0]!.speaker_id).toBe('spk_1');
  });

  it('uses punctuated_word as the alt, only when it differs', () => {
    const d = diarizeWords([
      { word: 'arr', start: 0, end: 0.5, confidence: 0.9, speaker: 0, punctuated_word: 'ARR.' },
      { word: 'so', start: 0.5, end: 0.8, confidence: 0.9, speaker: 0, punctuated_word: 'so' },
    ]);
    expect(d.words[0]!.alt).toBe('ARR.');
    expect(d.words[1]!.alt).toBeNull();
  });

  it('handles the empty-words case with a modest fallback confidence (no hardcoded 0.8 lie)', () => {
    const d = diarizeWords([]);
    expect(d.words).toEqual([]);
    expect(d.speaker_id).toBe('spk_1');
    expect(d.speaker_confidence).toBe(0.5);
    expect(d.is_overlap).toBe(false);
    expect(d.speaker_count).toBe(0);
  });

  it('clamps per-word confidence into [0,1] and never emits negative ms', () => {
    const d = diarizeWords([
      { word: 'q', start: -0.1, end: 0.2, confidence: 1.4, speaker: 0 },
    ]);
    expect(d.words[0]!.confidence).toBe(1);
    expect(d.words[0]!.start_ms).toBe(0);
    expect(d.words[0]!.end_ms).toBe(200);
  });

  it('honours custom speakerId / displayName mappers (per-track / enrollment hook)', () => {
    const d = diarizeWords([w('hi', 0, 0.5, 0)], {
      speakerId: (i) => `participant_${i}`,
      displayName: (i) => `P${i}`,
    });
    expect(d.speaker_id).toBe('participant_0');
    expect(d.display_name).toBe('P0');
    expect(d.words[0]!.speaker_id).toBe('participant_0');
  });
});
