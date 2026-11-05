// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

// Shared shape for the "magic wand" proofread feature. Lives here so the API
// (route validator + prompt builder) and the web client reference one canonical
// union instead of each redeclaring it.
export const proofreadFormatSchema = z.enum(["text", "html"])
export type ProofreadFormat = z.infer<typeof proofreadFormatSchema>

// ── Voice dictation (P1) ─────────────────────────────────────────────────────
// The wire contract of the dictation endpoints, shared so the web client and
// the API read one definition. A recording is posted as its raw bytes with the
// recording's own Content-Type; a long recording is cut by the CLIENT into
// self-contained segments of at most DICTATION_SEGMENT_SECONDS, each posted on
// its own with clean=false, their raw texts joined in order, then cleaned once
// through /assist/clean-dictation.

/** Largest accepted body for one transcription request, bytes. */
export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024
/** Longest accepted recording, seconds (the control auto-stops here). */
export const DICTATION_MAX_SECONDS = 300
/** The client restarts its recorder at this length, so each segment stays under upstream limits. */
export const DICTATION_SEGMENT_SECONDS = 45

/** Accepted audio media types (parameters such as `;codecs=opus` are allowed after them). */
export const TRANSCRIBE_AUDIO_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/mpeg",
  "audio/wav",
] as const
export type TranscribeAudioType = (typeof TRANSCRIBE_AUDIO_TYPES)[number]

/** The media type of a Content-Type header when it is one we accept, else null. */
export function transcribeAudioTypeOf(
  contentType: string | null | undefined,
): TranscribeAudioType | null {
  const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  return (TRANSCRIBE_AUDIO_TYPES as readonly string[]).includes(base)
    ? (base as TranscribeAudioType)
    : null
}

/** Query of POST /api/assist/transcribe. `clean` absent = the user's setting. */
export const transcribeQuerySchema = z.object({
  clean: z.enum(["true", "false"]).optional(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/, "ISO 639-1 code")
    .optional(),
})
export type TranscribeQuery = z.infer<typeof transcribeQuerySchema>

/** 200 body (inside the `data` envelope) of POST /api/assist/transcribe. */
export const transcribeResponseSchema = z.object({
  raw: z.string(),
  cleaned: z.string(),
  /** The transcription model key. */
  model: z.string(),
  /** The clean-up model key, null when no clean-up ran. */
  cleanModel: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  /** Present (true) when clean-up failed: `cleaned` is then `raw`. */
  cleanError: z.literal(true).optional(),
})
export type TranscribeResponse = z.infer<typeof transcribeResponseSchema>

/** Error codes of the dictation endpoints (`{ error: { code, message } }`). */
export const dictationErrorCodeSchema = z.enum([
  "too_large",
  "unsupported_format",
  "empty_audio",
  "rate_limited",
  "no_transcription_model",
  "insufficient_credits",
  "demo_key_required",
  "upstream_failed",
  // A demo visitor dictating on the demo box's key (its spend gate's codes).
  "demo_verification_required",
  "demo_budget_exhausted",
  "demo_network_exhausted",
  "demo_box_exhausted",
  "demo_rate_limited",
  "demo_busy",
  "demo_unavailable",
])
export type DictationErrorCode = z.infer<typeof dictationErrorCodeSchema>

/** Body of POST /api/assist/clean-dictation. */
export const cleanDictationRequestSchema = z.object({
  text: z.string().max(20_000),
  language: z
    .string()
    .regex(/^[a-z]{2}$/, "ISO 639-1 code")
    .optional(),
})
export type CleanDictationRequest = z.infer<typeof cleanDictationRequestSchema>

/** 200 body of POST /api/assist/clean-dictation. */
export const cleanDictationResponseSchema = z.object({
  cleaned: z.string(),
  cleanModel: z.string().nullable(),
  cleanError: z.literal(true).optional(),
})
export type CleanDictationResponse = z.infer<typeof cleanDictationResponseSchema>

/** 200 body of GET /api/assist/capabilities. */
export const assistCapabilitiesSchema = z.object({
  /** A transcription model resolves for this org (the mic control renders). */
  dictation: z.boolean(),
  /** The user's "Clean up dictation automatically" setting. */
  autoClean: z.boolean(),
})
export type AssistCapabilities = z.infer<typeof assistCapabilitiesSchema>

/** One transcription model an org can choose (GET /api/settings/ai/transcription). */
export const transcriptionModelOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  provider: z.string(),
  pricePerMinuteUsd: z.number(),
})
export type TranscriptionModelOption = z.infer<typeof transcriptionModelOptionSchema>

/** GET and PATCH response of /api/settings/ai/transcription. */
export const transcriptionSettingsSchema = z.object({
  available: z.array(transcriptionModelOptionSchema),
  /** The org's explicit choice, null = the default. */
  current: z.string().nullable(),
  /** What the org gets with no choice (null = no transcription-capable key). */
  default: z.string().nullable(),
})
export type TranscriptionSettings = z.infer<typeof transcriptionSettingsSchema>

/** PATCH body of /api/settings/ai/transcription (null clears the choice). */
export const transcriptionSettingsPatchSchema = z.strictObject({
  modelKey: z.string().min(1).max(200).nullable(),
})
export type TranscriptionSettingsPatch = z.infer<typeof transcriptionSettingsPatchSchema>

/** PUT body of /api/user/preferences/dictation. */
export const dictationPreferenceSchema = z.strictObject({
  autoClean: z.boolean(),
})
export type DictationPreference = z.infer<typeof dictationPreferenceSchema>
