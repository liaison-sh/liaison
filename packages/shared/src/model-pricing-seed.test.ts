// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { MODEL_PRICING_SEED } from "./model-pricing-seed"

// Model keys share one column (threads.agent_model_id, agents.model_preference,
// routines.agent_model_id): a native model's key is its catalogue id, an added
// model's key starts with `openrouter/` or `custom/`. The namespaces stay
// disjoint only while no native id carries one of those prefixes.
describe("model pricing seed", () => {
  it("has no native model id in the added-model namespaces", () => {
    const clashing = MODEL_PRICING_SEED.filter(
      (m) => m.modelId.startsWith("openrouter/") || m.modelId.startsWith("custom/"),
    )
    expect(clashing.map((m) => m.modelId)).toEqual([])
  })
})
