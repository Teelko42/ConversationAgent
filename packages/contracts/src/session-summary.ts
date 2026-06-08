import { z } from 'zod';

/**
 * `SessionSummary` — the payload of a `session_summary` F02 message (see
 * `F02MessageTypeSchema`). A live, best-effort "what you've missed" recap produced
 * by the live-intel worker every so often (and once more at session end): a short
 * paragraph plus a few key-point bullets.
 *
 * This is NOT a Phase-0 contract — it is an additive, observability-grade artifact
 * for the experience layer. Unlike ConceptCard/InsightItem it carries no consent
 * block of its own: it is derived from the same transcript the session already
 * governs, and is regenerated (not accumulated), so it inherits the session's
 * consent posture. `updated_at_us` is wall-clock µs (display only).
 */
export const SessionSummarySchema = z.object({
  /** 2–3 sentence catch-up recap of the conversation so far. */
  text: z.string(),
  /** Up to ~6 key-point bullets (may be empty). */
  bullets: z.array(z.string()).default([]),
  /** Wall-clock µs epoch when this recap was produced (display only). */
  updated_at_us: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
