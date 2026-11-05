// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, jest, mock } from "bun:test"
import { cleanDictation, DICTATION_CLEAN_TIMEOUT_MS, proofread } from "./proofread-service"

const baseInput = { orgId: "org_1", userId: "user_1" }

function deps(over: Partial<Parameters<typeof proofread>[1]> = {}) {
  return {
    loadInstructions: mock(async () => null as string | null),
    complete: mock(async () => ({ text: "Corrected text.", modelId: "m-1" })),
    ...over,
  }
}

describe("proofread", () => {
  it("returns the model's corrected text", async () => {
    const d = deps()
    const out = await proofread({ ...baseInput, text: "teh cat", format: "text" }, d)
    expect(out.text).toBe("Corrected text.")
    expect(d.complete).toHaveBeenCalledTimes(1)
  })

  it("loads the caller's instruction and bakes it into the system prompt", async () => {
    let seenSystem = ""
    const d = deps({
      loadInstructions: mock(async () => "Use British spelling."),
      complete: mock(async (args: { system: string }) => {
        seenSystem = args.system
        return { text: "Colour corrected.", modelId: "m-1" }
      }),
    })
    await proofread({ ...baseInput, text: "color", format: "text" }, d)
    expect(seenSystem).toContain("Use British spelling.")
  })

  it("short-circuits on empty/whitespace text without calling the model", async () => {
    const d = deps()
    const out = await proofread({ ...baseInput, text: "   ", format: "text" }, d)
    expect(out.text).toBe("   ")
    expect(d.complete).not.toHaveBeenCalled()
  })

  it("passes the html format through to the prompt builder", async () => {
    let seenSystem = ""
    const d = deps({
      complete: mock(async (args: { system: string }) => {
        seenSystem = args.system
        return { text: "<p>fixed</p>", modelId: "m-1" }
      }),
    })
    await proofread({ ...baseInput, text: "<p>teh</p>", format: "html" }, d)
    expect(seenSystem).toMatch(/HTML/)
  })
})

describe("cleanDictation", () => {
  it("returns the cleaned text and the model that cleaned it", async () => {
    let seenSystem = ""
    const d = deps({
      loadInstructions: mock(async () => "Vouvoiement."),
      complete: mock(async (args: { system: string }) => {
        seenSystem = args.system
        return { text: "Bonjour, je vous rappelle demain.", modelId: "gemini-flash-lite-latest" }
      }),
    })
    const out = await cleanDictation(
      { ...baseInput, text: "euh bonjour je je vous rappelle euh demain", language: "fr" },
      d,
    )
    expect(out).toEqual({
      cleaned: "Bonjour, je vous rappelle demain.",
      cleanModel: "gemini-flash-lite-latest",
    })
    expect(seenSystem).toContain("never translate")
    expect(seenSystem).toContain("Vouvoiement.")
  })

  it("never loses the transcript: a failing model returns it untouched, flagged", async () => {
    const d = deps({
      complete: mock(async () => {
        throw new Error("Out of agent usage")
      }),
    })
    const out = await cleanDictation({ ...baseInput, text: "um hello" }, d)
    expect(out).toEqual({ cleaned: "um hello", cleanModel: null, cleanError: true })
  })

  it("does not call a model for blank text", async () => {
    const d = deps()
    expect(await cleanDictation({ ...baseInput, text: "  " }, d)).toEqual({
      cleaned: "  ",
      cleanModel: null,
    })
    expect(d.complete).not.toHaveBeenCalled()
  })

  // SK2: a clean-up that never answers must not hold the request until its
  // 504. It is bounded (20 s, or what the caller's budget leaves), its model
  // call is aborted, and the transcript comes back untouched, flagged.
  describe("bounded in time", () => {
    afterEach(() => jest.useRealTimers())

    /** A model that never answers on its own; records the signal it was handed. */
    function hanging() {
      const seen: { signal?: AbortSignal } = {}
      const complete = mock(
        (args: { signal?: AbortSignal }) =>
          new Promise<{ text: string; modelId: string }>(() => {
            seen.signal = args.signal
          }),
      )
      return { seen, d: deps({ complete }) }
    }

    it("is 20 s by default", () => {
      expect(DICTATION_CLEAN_TIMEOUT_MS).toBe(20_000)
    })

    it("gives up at 20 s: the raw transcript, flagged, and the model call aborted", async () => {
      jest.useFakeTimers()
      const { seen, d } = hanging()
      let out: Awaited<ReturnType<typeof cleanDictation>> | undefined
      void cleanDictation({ ...baseInput, text: "um hello" }, d).then((r) => {
        out = r
      })
      for (let i = 0; i < 5; i++) await Promise.resolve()
      jest.advanceTimersByTime(DICTATION_CLEAN_TIMEOUT_MS - 1)
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(out).toBeUndefined()
      jest.advanceTimersByTime(1)
      for (let i = 0; i < 5 && !out; i++) await Promise.resolve()
      expect(out).toEqual({ cleaned: "um hello", cleanModel: null, cleanError: true })
      expect(seen.signal?.aborted).toBe(true)
    })

    it("gives up sooner when the caller's budget is shorter", async () => {
      const { seen, d } = hanging()
      const started = Date.now()
      const out = await cleanDictation({ ...baseInput, text: "um hello", timeoutMs: 30 }, d)
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(out).toEqual({ cleaned: "um hello", cleanModel: null, cleanError: true })
      expect(seen.signal?.aborted).toBe(true)
    })

    it("never waits longer than 20 s, whatever budget is offered", async () => {
      jest.useFakeTimers()
      const { d } = hanging()
      let out: Awaited<ReturnType<typeof cleanDictation>> | undefined
      void cleanDictation({ ...baseInput, text: "um", timeoutMs: 90_000 }, d).then((r) => {
        out = r
      })
      for (let i = 0; i < 5; i++) await Promise.resolve()
      jest.advanceTimersByTime(DICTATION_CLEAN_TIMEOUT_MS)
      for (let i = 0; i < 5 && !out; i++) await Promise.resolve()
      expect(out?.cleanError).toBe(true)
    })

    it("calls no model at all when no time is left", async () => {
      const d = deps()
      const out = await cleanDictation({ ...baseInput, text: "um", timeoutMs: 0 }, d)
      expect(out).toEqual({ cleaned: "um", cleanModel: null, cleanError: true })
      expect(d.complete).not.toHaveBeenCalled()
    })

    it("stops when the caller goes away", async () => {
      const { seen, d } = hanging()
      const gone = new AbortController()
      const pending = cleanDictation({ ...baseInput, text: "um", signal: gone.signal }, d)
      await Promise.resolve()
      gone.abort()
      expect((await pending).cleanError).toBe(true)
      expect(seen.signal?.aborted).toBe(true)
    })
  })
})
