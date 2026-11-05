// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"
import {
  analyzeWithGemini,
  mapUsageToTokens,
  redactSecrets,
} from "~/modules/agent/media/media-analysis-client"

const MODEL = {
  provider: "google",
  modelId: "gemini-flash-lite-latest",
  inputCostPerM: "0.09",
  outputCostPerM: "0.35",
}

describe("mapUsageToTokens", () => {
  it("maps prompt/candidates/thoughts directly", () => {
    expect(
      mapUsageToTokens({ promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 10 }),
    ).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it("falls back to (total - prompt) when candidates is missing", () => {
    expect(mapUsageToTokens({ promptTokenCount: 100, totalTokenCount: 160 })).toEqual({
      inputTokens: 100,
      outputTokens: 60,
    })
  })

  it("adds thoughts even on the (total - prompt) fallback path", () => {
    expect(
      mapUsageToTokens({ promptTokenCount: 100, totalTokenCount: 160, thoughtsTokenCount: 5 }),
    ).toEqual({ inputTokens: 100, outputTokens: 65 })
  })

  it("clamps a negative fallback (total < prompt) to zero — never negative cost", () => {
    expect(mapUsageToTokens({ promptTokenCount: 200, totalTokenCount: 160 })).toEqual({
      inputTokens: 200,
      outputTokens: 0,
    })
  })

  it("treats all-missing as {0,0}", () => {
    expect(mapUsageToTokens({})).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(mapUsageToTokens(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe("redactSecrets", () => {
  it("strips an API key query param", () => {
    const input =
      "GET https://generativelanguage.googleapis.com/v1/models?key=AIzaSECRET failed with 403"
    const out = redactSecrets(input)
    expect(out).not.toContain("AIzaSECRET")
    expect(out).toContain("REDACTED")
  })

  it("strips a Bearer token", () => {
    const out = redactSecrets("Authorization: Bearer ya29.SECRETTOKEN")
    expect(out).not.toContain("ya29.SECRETTOKEN")
    expect(out).toContain("REDACTED")
  })

  it("strips an x-goog-api-key header value", () => {
    const out = redactSecrets("x-goog-api-key: AIzaSyANOTHERSECRET")
    expect(out).not.toContain("AIzaSyANOTHERSECRET")
  })
})

describe("analyzeWithGemini", () => {
  function fakeFactory(generateContent: (args: unknown) => Promise<unknown>) {
    return () => ({ models: { generateContent } }) as never
  }

  it("returns summary + usage on the happy path", async () => {
    const generateContent = mock(async () => ({
      text: "It shows a cracked screen.",
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
    }))
    const res = await analyzeWithGemini(
      {
        providerKey: "AIzaTEST",
        model: MODEL,
        parts: [{ text: "hi" }],
        systemInstruction: "be terse",
        signal: new AbortController().signal,
      },
      { genaiClientFactory: fakeFactory(generateContent) },
    )
    expect(res.summary).toBe("It shows a cracked screen.")
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30 })
    expect(generateContent).toHaveBeenCalledTimes(1)
  })

  it("never leaks the API key when the SDK error embeds it", async () => {
    const generateContent = mock(async () => {
      throw new Error("Request to ...?key=AIzaSECRET failed")
    })
    let thrown: unknown
    try {
      await analyzeWithGemini(
        {
          providerKey: "AIzaSECRET",
          model: MODEL,
          parts: [{ text: "hi" }],
          systemInstruction: "x",
          signal: new AbortController().signal,
        },
        { genaiClientFactory: fakeFactory(generateContent) },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    const msg = (thrown as { error?: { message?: string } })?.error?.message ?? String(thrown)
    expect(msg).not.toContain("AIzaSECRET")
  })

  it("retries a transient 500 and succeeds on a later attempt", async () => {
    let calls = 0
    const generateContent = mock(async () => {
      calls++
      if (calls < 3) {
        // The shape the SDK throws for a media 5xx: an Error whose message is the
        // raw JSON body (no numeric `.status`), so transience is parsed from `code`.
        throw new Error('{"error":{"code":500,"message":"Internal error.","status":"INTERNAL"}}')
      }
      return { text: "It shows a lit pad surface.", usageMetadata: { promptTokenCount: 50 } }
    })
    const res = await analyzeWithGemini(
      {
        providerKey: "AIzaTEST",
        model: MODEL,
        parts: [{ text: "hi" }],
        systemInstruction: "x",
        signal: new AbortController().signal,
      },
      { genaiClientFactory: fakeFactory(generateContent) },
    )
    expect(res.summary).toBe("It shows a lit pad surface.")
    expect(generateContent).toHaveBeenCalledTimes(3)
  })

  it("exhausts retries on a persistent transient error, then throws model_error", async () => {
    const generateContent = mock(async () => {
      throw new Error(
        '{"error":{"code":503,"message":"Service unavailable.","status":"UNAVAILABLE"}}',
      )
    })
    let thrown: unknown
    try {
      await analyzeWithGemini(
        {
          providerKey: "AIzaTEST",
          model: MODEL,
          parts: [{ text: "hi" }],
          systemInstruction: "x",
          signal: new AbortController().signal,
        },
        { genaiClientFactory: fakeFactory(generateContent) },
      )
    } catch (e) {
      thrown = e
    }
    expect((thrown as { error?: { code?: string } })?.error?.code).toBe("model_error")
    // MODEL_CALL_MAX_ATTEMPTS = 3 (one initial + two retries).
    expect(generateContent).toHaveBeenCalledTimes(3)
  })

  it("does NOT retry a non-transient 400 — fails on the first attempt", async () => {
    const generateContent = mock(async () => {
      throw new Error(
        '{"error":{"code":400,"message":"Invalid argument.","status":"INVALID_ARGUMENT"}}',
      )
    })
    let thrown: unknown
    try {
      await analyzeWithGemini(
        {
          providerKey: "AIzaTEST",
          model: MODEL,
          parts: [{ text: "hi" }],
          systemInstruction: "x",
          signal: new AbortController().signal,
        },
        { genaiClientFactory: fakeFactory(generateContent) },
      )
    } catch (e) {
      thrown = e
    }
    expect((thrown as { error?: { code?: string } })?.error?.code).toBe("model_error")
    expect(generateContent).toHaveBeenCalledTimes(1)
  })

  it("rejects when the signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort("timeout")
    const generateContent = mock(async (rawArgs: unknown) => {
      const args = rawArgs as { config?: { abortSignal?: AbortSignal } }
      if (args.config?.abortSignal?.aborted) throw new Error("aborted")
      return { text: "x", usageMetadata: {} }
    })
    let thrown: unknown
    try {
      await analyzeWithGemini(
        {
          providerKey: "AIzaTEST",
          model: MODEL,
          parts: [{ text: "hi" }],
          systemInstruction: "x",
          signal: ac.signal,
        },
        { genaiClientFactory: fakeFactory(generateContent) },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    // The aborted path must map to the typed `timeout` code (toClientError uses
    // `args.signal.aborted ? 'timeout' : 'model_error'`). A flipped ternary
    // would survive a bare "did it reject" assertion.
    expect((thrown as { error?: { code?: string } })?.error?.code).toBe("timeout")
  })
})
