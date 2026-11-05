// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  parseServedModels,
  pickableModelGroups,
  pickableModels,
  setServedModels,
} from "./model-groups"
import { SERVED_MODELS_FIXTURE } from "./model-groups.fixture"

describe("pickableModels (walk N4: never offer a model the workspace cannot run)", () => {
  beforeEach(() => setServedModels(parseServedModels(SERVED_MODELS_FIXTURE)))
  afterEach(() => setServedModels(null))

  it("offers only the models the org can run", () => {
    const ids = pickableModels(new Set(["gemini-flash-lite-latest"]), null).map((m) => m.id)
    expect(ids).toEqual(["gemini-flash-lite-latest"])
  })

  it("keeps the current choice listed, marked unavailable, when it can no longer run", () => {
    const list = pickableModels(new Set(["gemini-flash-lite-latest"]), "claude-haiku-4-5")
    expect(list.at(-1)).toMatchObject({
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      unavailable: true,
    })
  })

  it("offers every served model when no narrower set is given", () => {
    expect(pickableModels(null, null)).toHaveLength(SERVED_MODELS_FIXTURE.models.length)
  })

  it("groups the offer by provider label, in the served order", () => {
    expect(pickableModelGroups(null, null).map((g) => g.provider)).toEqual([
      "Anthropic",
      "OpenAI",
      "Google",
      "Mistral",
    ])
  })
})

describe("pickableModels before the list is read", () => {
  afterEach(() => setServedModels(null))

  it("invents nothing, and keeps the current choice without calling it unavailable", () => {
    setServedModels(null)
    expect(pickableModels(null, null)).toEqual([])
    expect(pickableModels(null, "claude-haiku-4-5")).toEqual([
      {
        id: "claude-haiku-4-5",
        label: "claude-haiku-4-5",
        tierMinimum: "starter",
        unavailable: false,
      },
    ])
  })
})
