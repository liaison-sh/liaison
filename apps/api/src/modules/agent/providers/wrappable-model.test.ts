// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { MockLanguageModelV3, MockLanguageModelV4 } from "ai/test"
import { withAnswerAfterTools } from "./answer-after-tools"
import { withStepTokenCap } from "./step-token-cap"
import { withTextToolCalls } from "./text-tool-calls"
import { isWrappableModel } from "./wrappable-model"

// Real providers build v4 models since AI SDK 7. Each middleware used to wrap
// only "v3": it then left every real model unwrapped (the step token cap
// refused to run at all), while the v3 mocks kept the tests green.
describe("our model middlewares wrap what the SDK builds", () => {
  for (const [spec, make] of [
    ["v3", () => new MockLanguageModelV3()],
    ["v4", () => new MockLanguageModelV4()],
  ] as const) {
    it(`wraps a ${spec} model`, () => {
      const model = make()
      expect(isWrappableModel(model)).toBe(true)
      expect(withTextToolCalls(model)).not.toBe(model)
      expect(withAnswerAfterTools(model)).not.toBe(model)
      expect(withStepTokenCap(model, { maxOutputTokens: 100 })).not.toBe(model)
    })
  }

  it("leaves a model id string to the SDK", () => {
    expect(isWrappableModel("anthropic/claude")).toBe(false)
    expect(withTextToolCalls("anthropic/claude")).toBe("anthropic/claude")
  })
})
