import { z } from 'zod';

/**
 * `UserSource` — a piece of context the USER hands the AI during a session
 * (New_Feature.md F2 §4): a pasted note, a brief, or a URL with a comment
 * ("this is the spec we're discussing"). It lets the explain + follow-up engines
 * ground their answers in information the web search can't reach — crucially this
 * works even with no Tavily key, since a question can then be answered from the
 * user's own context alone.
 *
 *   • `text`  — the source body (required); the substance the AI reads.
 *   • `title` — an optional short label ("Q4 launch brief").
 *   • `url`   — an optional link the user is referencing. We do NOT fetch it
 *               server-side (F2 §11 out of scope); the URL + the user's note ride
 *               along as context, and a cited user source renders the link when
 *               present.
 *
 * Privacy (team-09, F2 §8): user-pasted text is conversation data and rides the
 * SAME consent posture as the transcript — it is kept client-side + in-memory and
 * shipped with each request, never logged raw server-side.
 */
export const UserSourceSchema = z.object({
  /** Stable client-assigned id, used to add/remove and to key citations. */
  id: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  text: z.string(),
});
export type UserSource = z.infer<typeof UserSourceSchema>;
