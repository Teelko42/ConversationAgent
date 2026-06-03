import { z } from 'zod';

/**
 * `SentenceExplanation` — the F02 "explain engine" output for a WHOLE sentence
 * (the placeholder the ConceptCard left open: "explanation block … added with the
 * explain engine"). Unlike a `ConceptCard` (keyed on one term), this is keyed on a
 * final `TranscriptSegment` and answers three things on demand:
 *
 *   1. `explanation` — what the sentence/phrase MEANS, in plain language.
 *   2. `breakdown`   — specific key/difficult words, each with a short meaning.
 *   3. `answer`      — when the sentence is a QUESTION, a short answer grounded in
 *                      web `sources` (INV-1/2: every web claim carries a URL).
 *
 * It is produced on user request (F03 click), not auto-emitted per term — so it
 * carries no revision/state lifecycle beyond `degraded` (the model/gateway fell
 * back) vs `ok`.
 */

/** One broken-down word/phrase from the sentence. */
export const WordBreakdownSchema = z.object({
  word: z.string(),
  meaning: z.string(),
});
export type WordBreakdown = z.infer<typeof WordBreakdownSchema>;

/** A web source backing a question's answer (INV-1/2: URL required). */
export const ExplanationSourceSchema = z.object({
  citation_id: z.string(),
  type: z.literal('web'),
  url: z.string(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  support_score: z.number().min(0).max(1).optional(),
});
export type ExplanationSource = z.infer<typeof ExplanationSourceSchema>;

export const SentenceExplanationSchema = z.object({
  id: z.string(), // derived from segment_id (stable per sentence)
  session_id: z.string(),
  tenant_id: z.string(),
  segment_id: z.string(), // the F01 segment this explains

  sentence: z.string(),
  explanation: z.string(),
  breakdown: z.array(WordBreakdownSchema),

  is_question: z.boolean(),
  /** Grounded short answer when `is_question`; null when not a question or unanswerable. */
  answer: z.string().nullable(),
  sources: z.array(ExplanationSourceSchema),

  /** 'degraded' when the gateway fell back (no real explanation/answer synthesized). */
  state: z.enum(['ok', 'degraded']),
});
export type SentenceExplanation = z.infer<typeof SentenceExplanationSchema>;
