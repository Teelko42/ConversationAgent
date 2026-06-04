import { z } from 'zod';

/**
 * `UserSource` — a piece of context the USER hands the AI during a session
 * (New_Feature.md F2 §4): a pasted note, a brief, or a URL with a comment
 * ("this is the spec we're discussing"). It lets the explain + follow-up engines
 * ground their answers in information the web search can't reach — crucially this
 * works even with no Tavily key, since a question can then be answered from the
 * user's own context alone.
 *
 *   • `text`   — the source body (required); the substance the AI reads.
 *   • `title`  — an optional short label ("Q4 launch brief"); a filename (F3) or a
 *                vault-relative note path (F4) when the source comes from one.
 *   • `url`    — an optional link the user is referencing. We do NOT fetch it
 *                server-side (F2 §11 out of scope); the URL + the user's note ride
 *                along as context, and a cited user source renders the link when
 *                present.
 *   • `origin` — where the source came from (S0 / F3 §4): a pasted note, a local
 *                `file`, or an `obsidian` vault note. Optional + advisory — it only
 *                drives citation provenance (`type:'file'|'obsidian'` vs `'user'`)
 *                and the UI icon; absent ⇒ treated as a paste (`type:'user'`). The
 *                engine never branches its grounding on it.
 *
 * Privacy (team-09, F2 §8 / F3 §9 / F4 §7): user text is conversation data and
 * rides the SAME consent posture as the transcript — kept client-side + in-memory,
 * shipped (only the S0-selected chunks) with each request, never logged raw.
 */
export const UserSourceSchema = z.object({
  /** Stable client-assigned id, used to add/remove and to key citations. */
  id: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  text: z.string(),
  /** Provenance (advisory): 'paste' (default) | 'file' | 'obsidian'. */
  origin: z.enum(['paste', 'file', 'obsidian']).optional(),
});
export type UserSource = z.infer<typeof UserSourceSchema>;
