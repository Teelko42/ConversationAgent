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

/**
 * A source backing a question's answer. Two kinds (New_Feature.md F2 §4):
 *   • `web`  — a retrieved web page. INV-1/2 still holds: a web source MUST carry
 *              a `url` so F03 can show provenance (enforced by the refine below).
 *   • `user` — context the user provided (a pasted note / a URL-with-comment). It
 *              may have no `url`, in which case the UI renders it without a link.
 * Reused by `FollowupAnswer`, so this one shape covers both engines.
 */
export const ExplanationSourceSchema = z
  .object({
    citation_id: z.string(),
    type: z.enum(['web', 'user']),
    /** Required for `web` (INV-1/2); optional for `user` sources without a link. */
    url: z.string().optional(),
    title: z.string().optional(),
    snippet: z.string().optional(),
    support_score: z.number().min(0).max(1).optional(),
  })
  .refine((s) => s.type !== 'web' || (typeof s.url === 'string' && s.url.length > 0), {
    message: 'a web source must carry a url (INV-1/2)',
    path: ['url'],
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
