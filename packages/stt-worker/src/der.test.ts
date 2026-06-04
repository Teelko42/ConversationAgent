import { describe, it, expect } from 'vitest';
import { computeDer, parseRttm, type Turn } from './der.js';

const t = (speaker: string, start: number, end: number): Turn => ({ speaker, start, end });

describe('computeDer — DER decomposition (§7/§9.7)', () => {
  it('perfect diarization (relabeled) → DER 0 and the right mapping', () => {
    const ref = [t('A', 0, 10)];
    const hyp = [t('X', 0, 10)];
    const r = computeDer(ref, hyp, { collar: 0 });
    expect(r.der).toBe(0);
    expect(r.missed).toBe(0);
    expect(r.falseAlarm).toBe(0);
    expect(r.confusion).toBe(0);
    expect(r.totalReference).toBe(10);
    expect(r.mapping).toEqual({ X: 'A' }); // hypothesis→reference
  });

  it('all reference speech missed → DER 1.0', () => {
    const r = computeDer([t('A', 0, 10)], [], { collar: 0 });
    expect(r.missed).toBe(10);
    expect(r.der).toBe(1);
  });

  it('resolves arbitrary label permutations via the optimal mapping', () => {
    const ref = [t('A', 0, 5), t('B', 5, 10)];
    // Hypothesis labels are swapped relative to reference but timing is perfect.
    const hyp = [t('Y', 0, 5), t('X', 5, 10)];
    const r = computeDer(ref, hyp, { collar: 0 });
    expect(r.der).toBe(0);
    expect(r.mapping).toEqual({ Y: 'A', X: 'B' });
  });

  it('counts pure speaker confusion', () => {
    // Reference: one speaker for 10s. Hypothesis splits it into two labels.
    const ref = [t('A', 0, 10)];
    const hyp = [t('X', 0, 5), t('Y', 5, 10)];
    const r = computeDer(ref, hyp, { collar: 0 });
    // Best mapping pairs A with X (or Y); the other 5s is confusion.
    expect(r.confusion).toBeCloseTo(5, 5);
    expect(r.missed).toBe(0);
    expect(r.falseAlarm).toBe(0);
    expect(r.der).toBeCloseTo(0.5, 5);
  });

  it('counts false alarm (and DER can exceed 1.0)', () => {
    const ref = [t('A', 0, 5)];
    const hyp = [t('X', 0, 10)]; // 5s of speech where the reference is silent
    const r = computeDer(ref, hyp, { collar: 0 });
    expect(r.falseAlarm).toBeCloseTo(5, 5);
    expect(r.totalReference).toBe(5);
    expect(r.der).toBeCloseTo(1, 5);
  });

  it('scores overlapped reference regions when scoreOverlap=true', () => {
    // Two reference speakers fully overlap 0–10; hypothesis hears only one.
    const ref = [t('A', 0, 10), t('B', 0, 10)];
    const hyp = [t('X', 0, 10)];
    const r = computeDer(ref, hyp, { collar: 0, scoreOverlap: true });
    expect(r.missed).toBeCloseTo(10, 5); // one of two overlapping speakers missed
    expect(r.totalReference).toBeCloseTo(20, 5); // 2 speakers × 10s
    expect(r.der).toBeCloseTo(0.5, 5);
  });

  it('excludes reference-overlap regions when scoreOverlap=false', () => {
    const ref = [t('A', 0, 10), t('B', 0, 10)];
    const hyp = [t('X', 0, 10)];
    const r = computeDer(ref, hyp, { collar: 0, scoreOverlap: false });
    expect(r.totalReference).toBe(0); // the only region is overlap → skipped
    expect(r.der).toBe(0);
  });

  it('applies the collar as a no-score zone around reference boundaries', () => {
    // 10s reference, nothing recognized. A 0.25s collar removes 0.25s on each side
    // of each boundary (at 0 and 10) → only the inner 0.25..9.75 = 9.5s is scored.
    const r = computeDer([t('A', 0, 10)], [], { collar: 0.25 });
    expect(r.totalReference).toBeCloseTo(9.5, 5);
    expect(r.missed).toBeCloseTo(9.5, 5);
    expect(r.der).toBeCloseTo(1, 5);
  });

  it('a realistic mixed error (miss + FA + confusion) sums correctly', () => {
    const ref = [t('A', 0, 4), t('B', 4, 8)];
    // X covers A well; nothing for the first half of B (miss); Z is a spurious label (confusion/FA).
    const hyp = [t('X', 0, 4), t('Z', 6, 9)];
    const r = computeDer(ref, hyp, { collar: 0 });
    // 4..6 of B: missed (2s). 6..8: B present, hyp Z present but Z maps to B? Z only
    // overlaps B → Z→B, so 6..8 is correct. 8..9: FA (1s, ref silent).
    expect(r.missed).toBeCloseTo(2, 5);
    expect(r.falseAlarm).toBeCloseTo(1, 5);
    expect(r.confusion).toBeCloseTo(0, 5);
    expect(r.totalReference).toBeCloseTo(8, 5);
    expect(r.der).toBeCloseTo((2 + 1) / 8, 5);
  });

  it('empty reference and empty hypothesis → DER 0', () => {
    expect(computeDer([], [], { collar: 0 }).der).toBe(0);
  });
});

describe('parseRttm', () => {
  it('parses SPEAKER lines into turns and ignores comments/other lines', () => {
    const rttm = [
      '# a comment',
      'SPEAKER meeting 1 0.00 3.50 <NA> <NA> spkA <NA> <NA>',
      'SPEAKER meeting 1 3.50 2.00 <NA> <NA> spkB <NA> <NA>',
      'SPKR-INFO meeting 1 <NA> <NA> <NA> unknown spkA <NA> <NA>',
      '',
    ].join('\n');
    const turns = parseRttm(rttm);
    expect(turns).toEqual([
      { speaker: 'spkA', start: 0, end: 3.5 },
      { speaker: 'spkB', start: 3.5, end: 5.5 },
    ]);
  });

  it('round-trips through computeDer to score a parsed reference against itself', () => {
    const rttm = 'SPEAKER m 1 0.0 5.0 <NA> <NA> s1 <NA> <NA>\nSPEAKER m 1 5.0 5.0 <NA> <NA> s2 <NA> <NA>';
    const turns = parseRttm(rttm);
    expect(computeDer(turns, turns, { collar: 0 }).der).toBe(0);
  });
});
