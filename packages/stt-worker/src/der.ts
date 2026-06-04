/**
 * Diarization Error Rate (DER) scorer — the evaluation-harness core from
 * Speaker_Research.md §7 / §9.7. Pure and synthetic-testable: feed reference +
 * hypothesis turns, get the DER breakdown. Pair with `parseRttm` to score real
 * RTTM files once you have an in-domain labelled set (the report's first
 * open question is "measure Deepgram's DER on YOUR audio").
 *
 * DER = (missed speech + false alarm + speaker confusion) / total reference
 * speech, computed the way NIST `md-eval` / `pyannote.metrics` do it:
 *  - a **collar** (default 0.25 s, the field convention) creates no-score zones
 *    on each side of every reference boundary, forgiving timestamp jitter;
 *  - speaker **confusion** is measured under the OPTIMAL 1:1 mapping between
 *    hypothesis and reference speakers (the mapping that maximises correctly
 *    attributed time) — diarization labels are arbitrary, so `spk_1` in the
 *    hypothesis need not be `spk_1` in the reference;
 *  - **scoreOverlap** toggles whether overlapped reference regions (Nref>1) are
 *    scored; excluding overlap inflates the score, so always report which you used.
 *
 * Per scored elementary region of duration d (Nref/Nsys = # active ref/sys
 * speakers, Ncorrect = # ref speakers whose mapped hyp speaker is also active):
 *   missed     += d · max(0, Nref − Nsys)
 *   falseAlarm += d · max(0, Nsys − Nref)
 *   confusion  += d · (min(Nref, Nsys) − Ncorrect)
 *   totalRef   += d · Nref
 */

/** A speaker turn. `speaker` is an arbitrary label; the mapping is solved internally. */
export interface Turn {
  speaker: string;
  /** Start time, seconds. */
  start: number;
  /** End time, seconds (must be ≥ start; non-positive-length turns are ignored). */
  end: number;
}

export interface DerOptions {
  /** No-score half-window (s) applied on EACH side of every reference boundary. Default 0.25. */
  collar?: number;
  /** Score overlapped reference regions (Nref > 1)? Default true (DIHARD-style). */
  scoreOverlap?: boolean;
}

export interface DerResult {
  /** Diarization Error Rate in [0, ∞) — fraction of reference speech mishandled (FA can push it >1). */
  der: number;
  /** Seconds of reference speech with too few hypothesis speakers. */
  missed: number;
  /** Seconds of hypothesis speech with too few reference speakers. */
  falseAlarm: number;
  /** Seconds attributed to the wrong (mapped) speaker. */
  confusion: number;
  /** Total scored reference speech (the DER denominator), seconds. */
  totalReference: number;
  /** The optimal hypothesis→reference speaker mapping used to score confusion. */
  mapping: Record<string, string>;
  /** Component rates (each divided by totalReference; 0 when there is no reference speech). */
  rates: { missed: number; falseAlarm: number; confusion: number };
}

const uniqueLabels = (turns: readonly Turn[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of turns) {
    if (!seen.has(t.speaker)) {
      seen.add(t.speaker);
      out.push(t.speaker);
    }
  }
  return out;
};

/**
 * Optimal 1:1 assignment maximising Σ cooccur[ref][sys]. Exact via a sys-bitmask
 * DP when the hypothesis speaker count is small (≤ 16 — the realistic case for an
 * in-domain product eval); greedy fallback above that, which is approximate.
 */
function optimalAssignment(
  refSpeakers: string[],
  sysSpeakers: string[],
  cooccur: number[][],
): { refToSys: Map<number, number> } {
  const m = refSpeakers.length;
  const n = sysSpeakers.length;
  const refToSys = new Map<number, number>();
  if (m === 0 || n === 0) return { refToSys };

  if (n > 16) {
    // Greedy fallback: take the heaviest available (ref, sys) pair repeatedly.
    const pairs: Array<[number, number, number]> = [];
    for (let r = 0; r < m; r++) for (let s = 0; s < n; s++) pairs.push([cooccur[r]![s]!, r, s]);
    pairs.sort((a, b) => b[0] - a[0]);
    const usedRef = new Set<number>();
    const usedSys = new Set<number>();
    for (const [w, r, s] of pairs) {
      if (w <= 0) break;
      if (usedRef.has(r) || usedSys.has(s)) continue;
      refToSys.set(r, s);
      usedRef.add(r);
      usedSys.add(s);
    }
    return { refToSys };
  }

  const full = 1 << n;
  const NONE = -1;
  // dp[i][mask] = best correct time assigning ref speakers [i..m) given used-sys `mask`.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(full).fill(0));
  const choice: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(full).fill(NONE));
  for (let i = m - 1; i >= 0; i--) {
    for (let mask = 0; mask < full; mask++) {
      let best = dp[i + 1]![mask]!; // ref i maps to nobody
      let bestChoice = NONE;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const val = cooccur[i]![j]! + dp[i + 1]![mask | (1 << j)]!;
        if (val > best) {
          best = val;
          bestChoice = j;
        }
      }
      dp[i]![mask] = best;
      choice[i]![mask] = bestChoice;
    }
  }
  let mask = 0;
  for (let i = 0; i < m; i++) {
    const j = choice[i]![mask]!;
    if (j !== NONE) {
      refToSys.set(i, j);
      mask |= 1 << j;
    }
  }
  return { refToSys };
}

/** Active speakers (as label-index sets) at a probe time, over a label list. */
function activeAt(turns: readonly Turn[], labelIndex: Map<string, number>, t: number): Set<number> {
  const out = new Set<number>();
  for (const turn of turns) {
    if (turn.end > turn.start && t >= turn.start && t < turn.end) out.add(labelIndex.get(turn.speaker)!);
  }
  return out;
}

/** Compute DER and its components for a reference vs hypothesis diarization. */
export function computeDer(
  reference: readonly Turn[],
  hypothesis: readonly Turn[],
  opts: DerOptions = {},
): DerResult {
  const collar = opts.collar ?? 0.25;
  const scoreOverlap = opts.scoreOverlap ?? true;

  const refSpeakers = uniqueLabels(reference);
  const sysSpeakers = uniqueLabels(hypothesis);
  const refIndex = new Map(refSpeakers.map((s, i) => [s, i] as const));
  const sysIndex = new Map(sysSpeakers.map((s, i) => [s, i] as const));

  // Elementary intervals: cut at every ref/hyp boundary and every collar edge.
  const points = new Set<number>();
  for (const t of reference) {
    if (t.end <= t.start) continue;
    for (const b of [t.start, t.end]) {
      points.add(b);
      points.add(b - collar);
      points.add(b + collar);
    }
  }
  for (const t of hypothesis) {
    if (t.end <= t.start) continue;
    points.add(t.start);
    points.add(t.end);
  }
  const cuts = [...points].sort((a, b) => a - b);

  const refBoundaries: number[] = [];
  for (const t of reference) {
    if (t.end > t.start) refBoundaries.push(t.start, t.end);
  }
  const inCollar = (t: number): boolean =>
    collar > 0 && refBoundaries.some((b) => Math.abs(t - b) < collar);

  // Build scored intervals once; reuse for both the mapping pass and the scoring pass.
  interface Region {
    d: number;
    ref: Set<number>;
    sys: Set<number>;
  }
  const regions: Region[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    const d = b - a;
    if (d <= 0) continue;
    const mid = (a + b) / 2;
    if (inCollar(mid)) continue; // no-score collar zone
    const ref = activeAt(reference, refIndex, mid);
    const sys = activeAt(hypothesis, sysIndex, mid);
    if (ref.size === 0 && sys.size === 0) continue;
    if (!scoreOverlap && ref.size > 1) continue; // skip reference-overlap regions
    regions.push({ d, ref, sys });
  }

  // Mapping pass: co-occurrence (shared time) between each ref and sys speaker.
  const cooccur: number[][] = refSpeakers.map(() => new Array<number>(sysSpeakers.length).fill(0));
  for (const reg of regions) {
    for (const r of reg.ref) for (const s of reg.sys) cooccur[r]![s] = (cooccur[r]![s] ?? 0) + reg.d;
  }
  const { refToSys } = optimalAssignment(refSpeakers, sysSpeakers, cooccur);

  // Scoring pass.
  let missed = 0;
  let falseAlarm = 0;
  let confusion = 0;
  let totalReference = 0;
  for (const reg of regions) {
    const nRef = reg.ref.size;
    const nSys = reg.sys.size;
    let nCorrect = 0;
    for (const r of reg.ref) {
      const s = refToSys.get(r);
      if (s !== undefined && reg.sys.has(s)) nCorrect++;
    }
    missed += reg.d * Math.max(0, nRef - nSys);
    falseAlarm += reg.d * Math.max(0, nSys - nRef);
    confusion += reg.d * (Math.min(nRef, nSys) - nCorrect);
    totalReference += reg.d * nRef;
  }

  const mapping: Record<string, string> = {};
  for (const [r, s] of refToSys) mapping[sysSpeakers[s]!] = refSpeakers[r]!;

  const denom = totalReference > 0 ? totalReference : 0;
  const rate = (x: number): number => (denom > 0 ? x / denom : 0);
  return {
    der: rate(missed + falseAlarm + confusion),
    missed,
    falseAlarm,
    confusion,
    totalReference,
    mapping,
    rates: { missed: rate(missed), falseAlarm: rate(falseAlarm), confusion: rate(confusion) },
  };
}

/**
 * Parse NIST RTTM into turns. RTTM `SPEAKER` lines are whitespace-delimited:
 *   `SPEAKER <file> <chan> <start> <dur> <NA> <NA> <speaker> <NA> <NA>`
 * (field 3 = start, field 4 = duration, field 7 = speaker). Other line types and
 * blank/`#` lines are ignored.
 */
export function parseRttm(rttm: string): Turn[] {
  const turns: Turn[] = [];
  for (const raw of rttm.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split(/\s+/);
    if (f[0] !== 'SPEAKER') continue;
    const start = Number(f[3]);
    const dur = Number(f[4]);
    const speaker = f[7];
    if (!Number.isFinite(start) || !Number.isFinite(dur) || speaker === undefined) continue;
    turns.push({ speaker, start, end: start + dur });
  }
  return turns;
}
