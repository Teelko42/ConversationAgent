import { z } from 'zod';
import { ExplanationSourceSchema } from './sentence-explanation.js';

/**
 * `FollowupAnswer` — the answer to a user-typed follow-up question asked *after* a
 * sentence has been explained (the F1 "ask back" loop). Unlike
 * `SentenceExplanation` (which grounds a question purely in fresh web search and
 * never sees the transcript), a follow-up is answered in the context of the
 * sentence it is about AND the surrounding conversation, so context-dependent
 * questions ("what did he mean by that?", "give me a simpler explanation") get a
 * real answer instead of `null`.
 *
 *   • `segment_id` — the sentence the follow-up attaches to (selected, else the
 *      most recent final segment).
 *   • `question`   — the user's typed question, echoed back so the client can match
 *      a reply to its thread entry independently of the transport `ask_id`.
 *   • `answer`     — a short answer grounded in conversation context + web sources,
 *      or `null` when it cannot be answered (unknown / degraded).
 *   • `sources`    — web sources backing the answer (INV-1/2: every web claim
 *      carries a URL). Reuses `ExplanationSource` so the UI renders them identically.
 *   • `state`      — 'degraded' when the gateway fell back (stub provider / cost
 *      ceiling), 'ok' otherwise. The engine never throws — it always resolves to
 *      this shape so the UI button never wedges.
 */
export const FollowupAnswerSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  tenant_id: z.string(),
  segment_id: z.string(),

  question: z.string(),
  /** Grounded short answer; null when unanswerable or degraded. */
  answer: z.string().nullable(),
  sources: z.array(ExplanationSourceSchema),

  /** 'degraded' when the gateway fell back (no real answer synthesized). */
  state: z.enum(['ok', 'degraded']),
});
export type FollowupAnswer = z.infer<typeof FollowupAnswerSchema>;
