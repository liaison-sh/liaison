// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TRANSCRIPTION MODELS (D11, S7): which speech-to-text model an org's dictation
// runs on.
//
// The candidates are OpenRouter's transcription models (POST
// /audio/transcriptions), priced per second of audio at OpenRouter's list
// price (GET /models?output_modalities=transcription, read 2026-10-23), plus
// Gemini audio input as the fallback for an org whose only key is Google's.
// An org may pick one (settings `ai.transcription.modelKey`); otherwise it
// gets the measured default, chosen by the FR+EN bake-off
// (scripts/dictation-bakeoff.ts), or the Gemini fallback.
//
// Availability is the question `resolveKey` answers, asked without performing
// it (`isProviderUsable`): the org's own key, or the deployment's when this
// org may reach it. So a demo visitor org without a key of its own has no
// transcription model at all, and the mic is never offered to it.
import {
  DICTATION_MAX_SECONDS,
  type OrgKernelSettings,
  orgKernelSettingsSchema,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { getOrgKernelSettings } from "~/lib/settings"
import { quoteIdent } from "~/lib/sql-utils"
import { isProviderUsable } from "~/modules/agent/credits/credit-meter"
import { RESERVED_WORST_OUTPUT_USD_PER_M } from "~/modules/demo/demo-spend-ceiling"

export type TranscriptionProvider = "openrouter" | "google"

export interface TranscriptionModel {
  /** The model key (what settings and usage rows store). */
  key: string
  provider: TranscriptionProvider
  /** The id sent to the provider. */
  upstreamId: string
  label: string
  /** USD per second of audio. */
  pricePerSecondUsd: number
}

/** Gemini's documented audio rate: 32 tokens per second, Flash-Lite audio input USD 0.30 per 1M tokens. */
const GEMINI_FLASH_LITE_AUDIO_USD_PER_SECOND = (32 * 0.3) / 1_000_000

export const GEMINI_TRANSCRIPTION_KEY = "gemini-flash-lite-latest"

export const TRANSCRIPTION_MODELS: readonly TranscriptionModel[] = Object.freeze([
  {
    key: "openrouter/openai/whisper-large-v3-turbo",
    provider: "openrouter",
    upstreamId: "openai/whisper-large-v3-turbo",
    label: "Whisper large v3 turbo",
    pricePerSecondUsd: 0.00000333,
  },
  {
    key: "openrouter/qwen/qwen3-asr-1.7b",
    provider: "openrouter",
    upstreamId: "qwen/qwen3-asr-1.7b",
    label: "Qwen3 ASR 1.7B",
    pricePerSecondUsd: 0.0000075,
  },
  {
    key: "openrouter/qwen/qwen3-asr-0.6b",
    provider: "openrouter",
    upstreamId: "qwen/qwen3-asr-0.6b",
    label: "Qwen3 ASR 0.6B",
    pricePerSecondUsd: 0.00000333,
  },
  // Not Voxtral Mini 3B: its OpenRouter provider rejects WebM and M4A (HTTP 400
  // on every bake-off clip), and the server never transcodes.
  {
    key: GEMINI_TRANSCRIPTION_KEY,
    provider: "google",
    upstreamId: GEMINI_TRANSCRIPTION_KEY,
    label: "Gemini Flash-Lite (audio input)",
    pricePerSecondUsd: GEMINI_FLASH_LITE_AUDIO_USD_PER_SECOND,
  },
])

/**
 * The default for an org with an OpenRouter key and no choice of its own: the
 * bake-off winner (S4, 25 real FR+EN clips, 2026-10-22): Qwen3 ASR 1.7B, WER
 * 9.9% (Qwen3 ASR 0.6B 11.8%, Whisper turbo 15.5%), p50 759 ms. It accepts
 * WebM, M4A and MP4, so Safari and iOS recordings need no transcoding.
 */
export const MEASURED_DEFAULT_TRANSCRIPTION_KEY = "openrouter/qwen/qwen3-asr-1.7b"

/**
 * The hedge of the measured default (S6): Qwen3 ASR 0.6B, the runner-up on WER
 * (11.8%) on a different provider pool. The 1.7B's provider was unstable in the
 * bake-off and after it (p95 26 s, stretches of 33 to 51 s a call, 60 s
 * timeouts), so an org on the default that has not chosen a model asks the 0.6B
 * at the same time and takes its transcript when the 1.7B's is not there within
 * 3 s (transcribe-service.ts, PRIMARY_GRACE_MS).
 */
export const HEDGE_TRANSCRIPTION_KEY = "openrouter/qwen/qwen3-asr-0.6b"

/**
 * One transcription counted in the reserved demo org's token ledger at its
 * worst case: the longest accepted recording at the dearest candidate's price,
 * converted at the ceiling's worst output price (demo-spend-ceiling.ts).
 */
export const TRANSCRIPTION_TOKEN_EQUIVALENT = Math.ceil(
  (DICTATION_MAX_SECONDS * Math.max(...TRANSCRIPTION_MODELS.map((m) => m.pricePerSecondUsd))) /
    (RESERVED_WORST_OUTPUT_USD_PER_M / 1_000_000),
)

export function findTranscriptionModel(key: string): TranscriptionModel | null {
  return TRANSCRIPTION_MODELS.find((m) => m.key === key) ?? null
}

export interface TranscriptionModelDeps {
  loadSettings: (orgId: string) => Promise<OrgKernelSettings>
  isUsable: (orgId: string, provider: string, settings: OrgKernelSettings) => Promise<boolean>
}

export const defaultTranscriptionModelDeps: TranscriptionModelDeps = {
  loadSettings: (orgId) =>
    withPrivilegedDb(orgId, "transcription-models-settings", (tx) =>
      getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
    ),
  isUsable: (orgId, provider, settings) => isProviderUsable(orgId, provider, settings),
}

/**
 * The models this org can transcribe with: every OpenRouter candidate when an
 * OpenRouter key is usable; the Gemini fallback only when OpenRouter is not and
 * a Google key is. Never throws for a missing key: that is an empty list.
 */
export async function listAvailableTranscriptionModels(
  orgId: string,
  deps: TranscriptionModelDeps = defaultTranscriptionModelDeps,
  settings?: OrgKernelSettings,
): Promise<TranscriptionModel[]> {
  const s = settings ?? (await deps.loadSettings(orgId))
  if (await deps.isUsable(orgId, "openrouter", s)) {
    return TRANSCRIPTION_MODELS.filter((m) => m.provider === "openrouter")
  }
  if (await deps.isUsable(orgId, "google", s)) {
    return TRANSCRIPTION_MODELS.filter((m) => m.provider === "google")
  }
  return []
}

function chosenKeyOf(settings: OrgKernelSettings): string | null {
  return settings.ai?.transcription?.modelKey ?? null
}

/** What an org gets with no choice: the measured default, else the Gemini fallback, else null. */
function defaultOf(available: TranscriptionModel[]): TranscriptionModel | null {
  return (
    available.find((m) => m.key === MEASURED_DEFAULT_TRANSCRIPTION_KEY) ??
    available.find((m) => m.key === GEMINI_TRANSCRIPTION_KEY) ??
    null
  )
}

/**
 * What one dictation runs: the model, and the hedge started beside it, whose
 * transcript is taken when the model's is slow. The hedge is only ever set for the measured default on an org that
 * has chosen no model: an admin's explicit choice runs alone, as chosen.
 */
export interface TranscriptionPlan {
  model: TranscriptionModel
  hedge: TranscriptionModel | null
}

/**
 * The plan of this org's dictation: its own choice when that model is
 * available, else the measured default (hedged by the 0.6B when that is
 * available too), else the Gemini fallback, else null (no transcription-capable
 * key: the mic is not offered).
 */
export async function resolveTranscriptionPlan(
  orgId: string,
  deps: TranscriptionModelDeps = defaultTranscriptionModelDeps,
): Promise<TranscriptionPlan | null> {
  const settings = await deps.loadSettings(orgId)
  const available = await listAvailableTranscriptionModels(orgId, deps, settings)
  const chosenKey = chosenKeyOf(settings)
  const chosen = available.find((m) => m.key === chosenKey)
  if (chosen) return { model: chosen, hedge: null }
  const model = defaultOf(available)
  if (!model) return null
  const hedge =
    chosenKey === null && model.key === MEASURED_DEFAULT_TRANSCRIPTION_KEY
      ? (available.find((m) => m.key === HEDGE_TRANSCRIPTION_KEY) ?? null)
      : null
  return { model, hedge }
}

/** The admin view: what can be chosen, what is chosen, what the default is. */
export async function transcriptionSettingsView(
  orgId: string,
  deps: TranscriptionModelDeps = defaultTranscriptionModelDeps,
): Promise<{
  available: Array<{ key: string; label: string; provider: string; pricePerMinuteUsd: number }>
  current: string | null
  default: string | null
}> {
  const settings = await deps.loadSettings(orgId)
  const available = await listAvailableTranscriptionModels(orgId, deps, settings)
  return {
    available: available.map((m) => ({
      key: m.key,
      label: m.label,
      provider: m.provider,
      pricePerMinuteUsd: Math.round(m.pricePerSecondUsd * 60 * 1e8) / 1e8,
    })),
    current: chosenKeyOf(settings),
    default: defaultOf(available)?.key ?? null,
  }
}

/**
 * Set (or clear, with null) the org's transcription model. A key that is not
 * available to the org is refused. One `jsonb_set` on `{ai,transcription}`:
 * the statement is atomic and touches nothing else in the settings blob.
 */
export async function setTranscriptionModel(
  orgId: string,
  modelKey: string | null,
  deps: TranscriptionModelDeps = defaultTranscriptionModelDeps,
): Promise<{ ok: true } | { ok: false; code: "model_unavailable" }> {
  if (modelKey !== null) {
    const available = await listAvailableTranscriptionModels(orgId, deps)
    if (!available.some((m) => m.key === modelKey)) return { ok: false, code: "model_unavailable" }
  }
  const table = drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent("organizations")}`)
  const value = JSON.stringify({ modelKey })
  await withPrivilegedDb(orgId, "transcription-model-set", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${table}
      SET settings = jsonb_set(
            jsonb_set(COALESCE(settings, '{}'::jsonb), '{ai}', COALESCE(settings->'ai', '{}'::jsonb), true),
            '{ai,transcription}',
            ${value}::jsonb,
            true
          ),
          updated_at = now()
      WHERE id = ${orgId}::uuid
    `)
  })
  return { ok: true }
}
