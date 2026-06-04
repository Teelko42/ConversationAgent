/**
 * Diarization word-attribution (Speaker_Research.md §9.1 / §9.4) — the pure,
 * testable core that fixes the highest-leverage finding in the report.
 *
 * Deepgram live STT returns a per-WORD `speaker` index when `diarize=true`, but
 * the old mapper collapsed a whole utterance onto the FIRST word's speaker and
 * threw the per-word labels away. A turn that changed speakers mid-utterance was
 * therefore silently mis-attributed, the per-word `speaker_id` (which the F01
 * contract already carries) was never populated, and `speaker_confidence` /
 * `is_overlap` were hardcoded constants that lied to downstream consumers.
 *
 * This module maps Deepgram's words onto the contract `words[]` (each carrying
 * its own `speaker_id`), then derives the SEGMENT-level speaker by
 * **duration-weighted majority**, a **calibrated** `speaker_confidence` (the
 * dominant speaker's share of voiced time — not a constant), and an honest
 * `is_overlap` flag (true when the words disagree on who is speaking).
 *
 * NOTE (verified against Deepgram docs + the v5 SDK types): live streaming words
 * carry no per-word `speaker_confidence` (that field is pre-recorded only), which
 * is exactly why confidence is *derived* here rather than read off the wire.
 */
import type { TranscriptSegment } from '@aizen/contracts';

/** The subset of a Deepgram live word this module needs. Times are SECONDS. */
export interface DiarWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  /** 0-based diarization index; absent ⇒ treated as speaker 0. */
  speaker?: number;
  /** Punctuated/cased form, when smart_format/punctuate are on. */
  punctuated_word?: string;
}

/** A contract-shaped word (one element of `TranscriptSegment.words`). */
export type ContractWord = NonNullable<TranscriptSegment['words']>[number];

export interface DiarizedSegment {
  /** Per-word attribution for the contract `words[]` (ms timing, own speaker_id). */
  words: ContractWord[];
  /** Dominant speaker by duration-weighted majority. */
  speaker_id: string;
  /** Human label for the dominant speaker (kept consistent with speaker_id). */
  display_name: string;
  /** Calibrated: the dominant speaker's share of voiced duration, in [0,1]. */
  speaker_confidence: number;
  /** True when ≥2 distinct speakers appear among the words (word-level disagreement). */
  is_overlap: boolean;
  /** Distinct speaker count among the words (diagnostic; 0 when there are no words). */
  speaker_count: number;
}

export interface DiarizeOptions {
  /** 0-based Deepgram index → contract speaker_id. Default `spk_{idx+1}`. */
  speakerId?: (idx: number) => string;
  /** 0-based Deepgram index → display name. Default `Speaker {idx+1}`. */
  displayName?: (idx: number) => string;
  /** Confidence to report when there are no per-word labels at all. Default 0.5. */
  fallbackConfidence?: number;
}

const defaultSpeakerId = (idx: number): string => `spk_${idx + 1}`;
const defaultDisplayName = (idx: number): string => `Speaker ${idx + 1}`;
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Map Deepgram diarized words → contract words + the segment-level speaker.
 *
 * Dominant speaker = the speaker with the greatest summed word DURATION
 * (`end - start`); ties break toward the earliest-appearing speaker (arrival
 * order — the same stability principle behind streaming Sortformer). When every
 * word has non-positive duration (defensive: zero/garbled timestamps on very
 * short interim words) it falls back to word COUNT so a dominant speaker is still
 * chosen. `speaker_confidence` is the dominant speaker's share of that same
 * weight, so a clean single-speaker turn → 1.0 and an evenly-split overlap → ~0.5.
 */
export function diarizeWords(
  words: readonly DiarWord[],
  opts: DiarizeOptions = {},
): DiarizedSegment {
  const speakerId = opts.speakerId ?? defaultSpeakerId;
  const displayName = opts.displayName ?? defaultDisplayName;
  const fallbackConfidence = clamp01(opts.fallbackConfidence ?? 0.5);

  const contractWords: ContractWord[] = words.map((w) => {
    const idx = w.speaker ?? 0;
    const startMs = Math.max(0, Math.round(w.start * 1000));
    const endMs = Math.max(startMs, Math.round(w.end * 1000));
    const punct = w.punctuated_word;
    return {
      w: w.word,
      start_ms: startMs,
      end_ms: endMs,
      confidence: clamp01(w.confidence),
      speaker_id: speakerId(idx),
      is_domain_term: false,
      alt: punct && punct !== w.word ? punct : null,
    };
  });

  if (words.length === 0) {
    return {
      words: contractWords,
      speaker_id: speakerId(0),
      display_name: displayName(0),
      speaker_confidence: fallbackConfidence,
      is_overlap: false,
      speaker_count: 0,
    };
  }

  // Accumulate weight per speaker (duration; word count as fallback) and remember
  // the arrival order of speakers for deterministic tie-breaking.
  const byDuration = new Map<number, number>();
  const byCount = new Map<number, number>();
  const arrivalOrder: number[] = [];
  let totalDuration = 0;
  for (const w of words) {
    const idx = w.speaker ?? 0;
    if (!byCount.has(idx)) arrivalOrder.push(idx);
    const dur = Math.max(0, w.end - w.start);
    byDuration.set(idx, (byDuration.get(idx) ?? 0) + dur);
    byCount.set(idx, (byCount.get(idx) ?? 0) + 1);
    totalDuration += dur;
  }

  const useDuration = totalDuration > 0;
  const weight = useDuration ? byDuration : byCount;
  const total = useDuration ? totalDuration : words.length;

  let dominant = arrivalOrder[0]!;
  let dominantWeight = weight.get(dominant) ?? 0;
  for (const idx of arrivalOrder) {
    const w = weight.get(idx) ?? 0;
    if (w > dominantWeight) {
      dominant = idx;
      dominantWeight = w;
    }
  }

  return {
    words: contractWords,
    speaker_id: speakerId(dominant),
    display_name: displayName(dominant),
    speaker_confidence: clamp01(total > 0 ? dominantWeight / total : fallbackConfidence),
    is_overlap: byCount.size >= 2,
    speaker_count: byCount.size,
  };
}
