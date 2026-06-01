import { z } from 'zod';
import { F01EnvelopeSchema } from './envelope.js';

/** F01 `AudioFrame` (F01 data-contracts §2) — abridged to the spec-critical block. */

export const AudioConsentModeSchema = z.enum([
  'store_audio',
  'no_audio_retention',
  'transcript_only',
]);
export type AudioConsentMode = z.infer<typeof AudioConsentModeSchema>;

export const AudioSourceKindSchema = z.enum([
  'mic',
  'system_audio',
  'meeting_bot',
  'meeting_sdk',
  'virtual_device',
  'upload',
]);

export const AudioFrameSchema = F01EnvelopeSchema.extend({
  // timing (media clock)
  start_ms: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  session_start_at: z.number().int(),
  // payload
  codec: z.enum(['pcm_s16le', 'opus', 'flac']),
  sample_rate_hz: z.number().int().positive(),
  channels: z.number().int().positive(),
  samples: z.number().int().nonnegative(),
  payload: z.string().nullable(),
  payload_ref: z.string().nullable(),
  source: z.object({
    kind: AudioSourceKindSchema,
    platform: z.enum(['web', 'desktop', 'mobile_ios', 'mobile_android', 'server']),
    meeting_provider: z
      .enum(['zoom', 'teams', 'meet', 'webex', 'generic_sip'])
      .nullable(),
    channel_role: z.enum([
      'local_participant',
      'remote_mix',
      'remote_participant',
      'loopback_system',
    ]),
    participant_hint: z.string().nullable(),
  }),
  consent: z.object({
    mode: AudioConsentModeSchema,
    consent_id: z.string(),
    redaction_pending: z.boolean(),
  }),
});
export type AudioFrame = z.infer<typeof AudioFrameSchema>;
