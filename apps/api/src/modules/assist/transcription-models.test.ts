// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { OrgKernelSettings } from "@liaison/shared"
import {
  GEMINI_TRANSCRIPTION_KEY,
  HEDGE_TRANSCRIPTION_KEY,
  listAvailableTranscriptionModels,
  MEASURED_DEFAULT_TRANSCRIPTION_KEY,
  resolveTranscriptionPlan,
  TRANSCRIPTION_TOKEN_EQUIVALENT,
  type TranscriptionModelDeps,
  transcriptionSettingsView,
} from "./transcription-models"

const ORG = "org-1"
const QWEN = "openrouter/qwen/qwen3-asr-1.7b"

/** Key availability stubbed at the one question resolveKey would answer. */
function deps(usable: string[], chosen?: string | null): TranscriptionModelDeps {
  const settings: OrgKernelSettings =
    chosen === undefined ? {} : { ai: { transcription: { modelKey: chosen } } }
  return {
    loadSettings: async () => settings,
    isUsable: async (_org, provider) => usable.includes(provider),
  }
}

describe("resolveTranscriptionPlan", () => {
  it("uses the org's own choice when that model is available, never hedged", async () => {
    expect(await resolveTranscriptionPlan(ORG, deps(["openrouter"], QWEN))).toMatchObject({
      model: { key: QWEN },
      hedge: null,
    })
  })

  it("hedges the measured default with the 0.6B only when the org chose no model", async () => {
    expect(await resolveTranscriptionPlan(ORG, deps(["openrouter"]))).toMatchObject({
      model: { key: MEASURED_DEFAULT_TRANSCRIPTION_KEY },
      hedge: { key: HEDGE_TRANSCRIPTION_KEY },
    })
    // An explicit choice of the default itself is an admin's choice: it runs alone.
    expect(
      (
        await resolveTranscriptionPlan(
          ORG,
          deps(["openrouter"], MEASURED_DEFAULT_TRANSCRIPTION_KEY),
        )
      )?.hedge,
    ).toBeNull()
  })

  it("falls back to the measured default for a choice it cannot run, unhedged", async () => {
    expect(await resolveTranscriptionPlan(ORG, deps(["openrouter"], "nope/model"))).toMatchObject({
      model: { key: MEASURED_DEFAULT_TRANSCRIPTION_KEY },
      hedge: null,
    })
    // A Gemini choice made while only Google was keyed, once OpenRouter is keyed too.
    expect(
      (
        await resolveTranscriptionPlan(
          ORG,
          deps(["openrouter", "google"], GEMINI_TRANSCRIPTION_KEY),
        )
      )?.model.key,
    ).toBe(MEASURED_DEFAULT_TRANSCRIPTION_KEY)
  })

  it("uses Gemini audio input when only a Google key is usable", async () => {
    const plan = await resolveTranscriptionPlan(ORG, deps(["google"]))
    expect(plan?.model.key).toBe(GEMINI_TRANSCRIPTION_KEY)
    expect(plan?.model.provider).toBe("google")
    expect(plan?.hedge).toBeNull()
  })

  it("is null with no transcription-capable key", async () => {
    expect(await resolveTranscriptionPlan(ORG, deps(["anthropic", "openai"]))).toBeNull()
  })
})

describe("listAvailableTranscriptionModels", () => {
  it("lists every OpenRouter candidate, and Gemini only without OpenRouter", async () => {
    const or = await listAvailableTranscriptionModels(ORG, deps(["openrouter", "google"]))
    expect(or.map((m) => m.key)).toEqual([
      "openrouter/openai/whisper-large-v3-turbo",
      "openrouter/qwen/qwen3-asr-1.7b",
      "openrouter/qwen/qwen3-asr-0.6b",
    ])
    const google = await listAvailableTranscriptionModels(ORG, deps(["google"]))
    expect(google.map((m) => m.key)).toEqual([GEMINI_TRANSCRIPTION_KEY])
    expect(await listAvailableTranscriptionModels(ORG, deps([]))).toEqual([])
  })
})

describe("transcriptionSettingsView", () => {
  it("prices per minute and names the current choice and the default", async () => {
    const view = await transcriptionSettingsView(ORG, deps(["openrouter"], QWEN))
    expect(view.current).toBe(QWEN)
    expect(view.default).toBe(MEASURED_DEFAULT_TRANSCRIPTION_KEY)
    const whisper = view.available.find((m) => m.key === "openrouter/openai/whisper-large-v3-turbo")
    expect(whisper?.pricePerMinuteUsd).toBeCloseTo(0.0002, 6)
  })
})

it("the measured default is the bake-off winner (S4: lowest WER, p50 under 3 s)", () => {
  expect(MEASURED_DEFAULT_TRANSCRIPTION_KEY).toBe(QWEN)
})

it("counts a transcription in the reserved demo ledger at its worst case", () => {
  // 300 s at the dearest candidate (Gemini audio input, 32 tokens/s at 0.30
  // USD per 1M = 0.0000096 USD/s) at 2.5 USD per 1M tokens.
  expect(TRANSCRIPTION_TOKEN_EQUIVALENT).toBe(Math.ceil((300 * 0.0000096) / 2.5e-6))
})
