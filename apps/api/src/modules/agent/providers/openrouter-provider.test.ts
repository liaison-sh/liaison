// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S1: every OpenRouter call carries the routing options (no provider that
// trains on the data, and only providers that honour every parameter sent).
// S2: the product's reasoning levels map onto the model's own efforts.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Drop `data_collection` or `require_parameters` from the OpenRouter
//    factory: the request-body test fails.
//  * Send the reasoning effort as a provider setting the reasoning merge then
//    overwrites `provider` with: the "keeps routing next to reasoning" test fails.
//  * Clamp medium up instead of down: the DeepSeek mapping test fails.
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { generateText } from "ai"
import { resolveModel } from "~/modules/agent/providers/provider"
import { buildReasoning, clampReasoningEffort } from "~/modules/agent/providers/reasoning"

function completion(): Response {
  return new Response(
    JSON.stringify({
      id: "gen-1",
      object: "chat.completion",
      created: 1,
      model: "deepseek/deepseek-v4.1-flash",
      choices: [
        { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

let spy: ReturnType<typeof spyOn> | null = null
afterEach(() => {
  spy?.mockRestore()
  spy = null
  delete process.env.OPENROUTER_BASE_URL
})

async function captureBody(providerOptions?: Record<string, unknown>) {
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = []
  spy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    bodies.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) })
    return completion()
  }) as typeof fetch)
  const model = await resolveModel({
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4.1-flash",
    apiKey: "sk-or-test",
  })
  await generateText({
    model,
    prompt: "hi",
    ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
  })
  return bodies
}

describe("OpenRouter provider (S1)", () => {
  it("sends the upstream id with the data policy and parameter routing on the request", async () => {
    const bodies = await captureBody()
    expect(bodies.length).toBe(1)
    expect(bodies[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(bodies[0]!.body.model).toBe("deepseek/deepseek-v4.1-flash")
    expect(bodies[0]!.body.provider).toEqual({
      data_collection: "deny",
      require_parameters: true,
      // LIAISON_OPENROUTER_IGNORE_HOSTS defaults to OpenInference (env.ts).
      ignore: ["OpenInference"],
    })
  })

  it("keeps the routing options next to the reasoning options", async () => {
    const plan = buildReasoning("openrouter", "medium", "deepseek/deepseek-v4.1-flash", {
      reasoningEfforts: ["low", "high"],
      canDisableReasoning: true,
    })
    const bodies = await captureBody(plan.providerOptions)
    expect(bodies[0]!.body.provider).toEqual({
      data_collection: "deny",
      require_parameters: true,
      // LIAISON_OPENROUTER_IGNORE_HOSTS defaults to OpenInference (env.ts).
      ignore: ["OpenInference"],
    })
    expect(bodies[0]!.body.reasoning).toEqual({ effort: "low" })
  })

  it("honours OPENROUTER_BASE_URL", async () => {
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1"
    const bodies = await captureBody()
    expect(bodies[0]!.url).toBe("http://127.0.0.1:9/api/v1/chat/completions")
  })
})

describe("OpenRouter reasoning (S2)", () => {
  const deepseek = { reasoningEfforts: ["low", "high"] as const, canDisableReasoning: true }

  it("clamps a missing level to the nearest lower effort, else the nearest higher", () => {
    expect(clampReasoningEffort("medium", ["low", "high"])).toBe("low")
    expect(clampReasoningEffort("low", ["medium", "high"])).toBe("medium")
    expect(clampReasoningEffort("high", ["low"])).toBe("low")
    expect(clampReasoningEffort("medium", ["medium"])).toBe("medium")
    expect(clampReasoningEffort("medium", [])).toBeNull()
  })

  it("maps on levels to the clamped effort with full reasoning text", () => {
    for (const [level, effort] of [
      ["low", "low"],
      ["medium", "low"],
      ["high", "high"],
    ] as const) {
      const plan = buildReasoning("openrouter", level, "x", deepseek)
      expect(plan.providerOptions).toEqual({ openrouter: { reasoning: { effort } } })
      expect(plan.streamMode).toBe("full")
    }
  })

  it("maps Off to effort none when the model can switch reasoning off", () => {
    const plan = buildReasoning("openrouter", "off", "x", deepseek)
    expect(plan.providerOptions).toEqual({ openrouter: { reasoning: { effort: "none" } } })
    expect(plan.streamMode).toBe("none")
  })

  it("sends nothing for Off when reasoning is mandatory, and nothing for a model without efforts", () => {
    expect(
      buildReasoning("openrouter", "off", "x", {
        reasoningEfforts: ["low"],
        canDisableReasoning: false,
      }).providerOptions,
    ).toBeUndefined()
    expect(
      buildReasoning("openrouter", "high", "x", {
        reasoningEfforts: [],
        canDisableReasoning: false,
      }).providerOptions,
    ).toBeUndefined()
  })
})
