// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-FX5: which judge scores a run, and what the run says about it.
//
// No model runs here: the SDK call is a stub, so this pins the SELECTION (the
// login ladder first, the provider layer only when the login refuses) and the
// header that has to name both the judge and the path it came from. The live
// harness proves the SDK call itself against the real login.
import { describe, expect, it } from "bun:test"
import { reportHeaderLine } from "./harness"
import { JUDGE_SDK_MODELS, type ProviderJudgeResult, runJudge } from "./sdk-judge"

const PROMPT = "grade this"

function provider(result: ProviderJudgeResult): () => Promise<ProviderJudgeResult> {
  return async () => result
}

describe("which judge scores the run", () => {
  it("scores with the login when the strongest model answers", async () => {
    const asked: string[] = []
    const run = await runJudge({
      prompt: PROMPT,
      sdk: async (model, prompt) => {
        asked.push(model)
        expect(prompt).toBe(PROMPT)
        return '{"score": 5, "why": "fine"}'
      },
      provider: provider({ modelId: "gemini-pro-latest", text: "unused" }),
    })
    expect(run.path).toBe("sdk-login")
    expect(run.modelId).toBe(JUDGE_SDK_MODELS[0])
    expect(run.fallbackReason).toBe("")
    // The ladder stops at the first model that answers: the weaker ones are
    // never asked, so a run can never be silently scored by sonnet.
    expect(asked).toEqual([JUDGE_SDK_MODELS[0]])
  })

  it("walks down the login ladder when a model is refused", async () => {
    const asked: string[] = []
    const run = await runJudge({
      prompt: PROMPT,
      sdk: async (model) => {
        asked.push(model)
        if (model !== JUDGE_SDK_MODELS[2]) throw new Error(`model ${model} not available`)
        return "ok"
      },
      provider: provider({ modelId: "gemini-pro-latest", text: "unused" }),
    })
    expect(run.path).toBe("sdk-login")
    expect(run.modelId).toBe(JUDGE_SDK_MODELS[2])
    expect(asked).toEqual([...JUDGE_SDK_MODELS])
  })

  it("falls back to the provider judge only when every login model refuses", async () => {
    const run = await runJudge({
      prompt: PROMPT,
      sdk: async (model) => {
        throw new Error(`no login for ${model}`)
      },
      provider: provider({ modelId: "gemini-pro-latest", text: "ok", reason: "no anthropic key" }),
    })
    expect(run.path).toBe("provider")
    expect(run.modelId).toBe("gemini-pro-latest")
    // Loud, not silent: the reason names every model that refused, and the
    // provider layer's own reason is kept beside it.
    for (const model of JUDGE_SDK_MODELS) expect(run.fallbackReason).toContain(model)
    expect(run.fallbackReason).toContain("no anthropic key")
  })

  it("reports not run when the login refuses and there is no provider key", async () => {
    await expect(
      runJudge({
        prompt: PROMPT,
        sdk: async () => {
          throw new Error("Not logged in, please run /login")
        },
        provider: null,
      }),
    ).rejects.toThrow(/NOT RUN/)
  })

  it("names the judge that scored and the path it came from in the header", () => {
    const sdk = reportHeaderLine({
      date: "2026-09-13",
      agentModelId: "gemini-flash-lite-latest",
      judgeModelId: "claude-opus-4-6",
      judgePath: "sdk-login",
    })
    expect(sdk).toContain("claude-opus-4-6")
    expect(sdk).toContain("sdk-login")
    const fallback = reportHeaderLine({
      date: "2026-09-13",
      agentModelId: "gemini-flash-lite-latest",
      judgeModelId: "gemini-pro-latest",
      judgePath: "provider",
    })
    expect(fallback).toContain("gemini-pro-latest")
    expect(fallback).toContain("provider")
    expect(fallback).not.toContain("claude-opus-4-6")
  })
})
