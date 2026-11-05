// SPDX-License-Identifier: FSL-1.1-ALv2
// S6: every picker reads the served list. These pin the list itself: what the
// server sends is what is offered, grouped by provider label in the S6 order,
// with the served reasoning capability.
import { afterEach, describe, expect, it } from "vitest"
import {
  autoEntryLabel,
  getModelLabel,
  modelGroups,
  modelReasoning,
  parseServedModels,
  setServedModels,
} from "./model-groups"
import {
  SERVED_CUSTOM_MODEL,
  SERVED_MODELS_FIXTURE,
  SERVED_OPENROUTER_MODEL,
} from "./model-groups.fixture"

afterEach(() => setServedModels(null))

const native = (key: string) => {
  const m = SERVED_MODELS_FIXTURE.models.find((x) => x.key === key)
  if (!m) throw new Error(`no fixture model ${key}`)
  return m
}

function serve(models: unknown[], auto: { autoModelKey?: string; autoResolvedKey?: string } = {}) {
  setServedModels(
    parseServedModels({
      autoModelKey: auto.autoModelKey ?? null,
      autoResolvedKey: auto.autoResolvedKey ?? null,
      models,
    }),
  )
}

describe("modelGroups (S6)", () => {
  it("lists exactly the served models: an added OpenRouter model appears, an unserved one does not", () => {
    const haiku = native("claude-haiku-4-5")
    const flashLite = native("gemini-flash-lite-latest")
    serve([haiku, flashLite, SERVED_OPENROUTER_MODEL])
    const ids = modelGroups().flatMap((g) => g.models.map((m) => m.id))
    expect(ids).toEqual([null, haiku.key, flashLite.key, SERVED_OPENROUTER_MODEL.key])
    expect(ids).not.toContain("claude-opus-4-6")
    expect(ids).not.toContain("gpt-5.4")
  })

  it("groups by provider label: Auto, Anthropic, OpenAI, Google, Mistral, OpenRouter, then each server", () => {
    // Sent out of order on purpose: the order is the picker's, not the wire's.
    serve([
      SERVED_CUSTOM_MODEL,
      SERVED_OPENROUTER_MODEL,
      native("mistral-large-latest"),
      native("gemini-flash-lite-latest"),
      native("gpt-5.4"),
      native("claude-opus-4-6"),
    ])
    expect(modelGroups().map((g) => g.provider)).toEqual([
      "Auto",
      "Anthropic",
      "OpenAI",
      "Google",
      "Mistral",
      "OpenRouter",
      "GPU box",
    ])
  })

  it("offers Auto alone before the list is read", () => {
    expect(modelGroups()).toEqual([
      { provider: "Auto", models: [{ id: null, label: "Auto", tierMinimum: "starter" }] },
    ])
  })

  it("reads the legacy shape the server keeps for one release", () => {
    setServedModels(
      parseServedModels({
        models: [
          { modelId: "claude-haiku-4-5", provider: "anthropic", displayName: "Claude Haiku 4.5" },
        ],
      }),
    )
    expect(modelGroups()[1]).toEqual({
      provider: "Anthropic",
      models: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tierMinimum: "starter" }],
    })
  })
})

describe("labels", () => {
  it("names a served model by its served display name, an unknown one by its key", () => {
    serve([SERVED_OPENROUTER_MODEL])
    expect(getModelLabel(SERVED_OPENROUTER_MODEL.key)).toBe("DeepSeek V4.1 Flash")
    expect(getModelLabel("gone-model")).toBe("gone-model")
    expect(getModelLabel(null)).toBe("Auto")
  })

  it("the Auto entry names the model Auto runs once the server resolved it", () => {
    serve([SERVED_OPENROUTER_MODEL], { autoResolvedKey: SERVED_OPENROUTER_MODEL.key })
    expect(autoEntryLabel()).toBe("Auto · DeepSeek V4.1 Flash")
    serve([SERVED_OPENROUTER_MODEL])
    expect(autoEntryLabel()).toBe("Auto")
  })
})

describe("modelReasoning", () => {
  it("uses the served capability: an OpenRouter model with low/high and no Off", () => {
    serve([SERVED_OPENROUTER_MODEL])
    expect(modelReasoning(SERVED_OPENROUTER_MODEL.key)).toEqual({
      supportsReasoning: true,
      allowedLevels: ["low", "high"],
      defaultLevel: "low",
    })
  })

  it("hides the row for a served model that offers Off only", () => {
    serve([SERVED_CUSTOM_MODEL])
    expect(modelReasoning(SERVED_CUSTOM_MODEL.key).supportsReasoning).toBe(false)
  })

  it("hides the row for Auto", () => {
    expect(modelReasoning(null).supportsReasoning).toBe(false)
  })
})
