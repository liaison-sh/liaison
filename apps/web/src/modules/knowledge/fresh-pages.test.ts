// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { discardIfUntouched, isFreshPage, markFreshPage } from "./fresh-pages"

describe("fresh pages", () => {
  it("a New page left empty asks the server to discard it, once", async () => {
    const api = { post: vi.fn(async () => ({ deleted: true })) }
    markFreshPage("p1")
    expect(await discardIfUntouched(api as never, "p1", { body: "  \n" })).toBe(true)
    expect(api.post).toHaveBeenCalledWith(
      "/knowledge/documents/p1/discard-untouched",
      {},
      { suppressGlobalError: true },
    )
    expect(isFreshPage("p1")).toBe(false)
    expect(await discardIfUntouched(api as never, "p1", { body: "" })).toBe(false)
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it("never asks for a page with text, or one not made with New page here (an agent's)", async () => {
    const api = { post: vi.fn(async () => ({ deleted: true })) }
    markFreshPage("p2")
    expect(await discardIfUntouched(api as never, "p2", { body: "A line" })).toBe(false)
    expect(await discardIfUntouched(api as never, "agent-page", { body: "" })).toBe(false)
    expect(api.post).not.toHaveBeenCalled()
  })

  it("a refusal keeps the page and says it was not discarded", async () => {
    const api = {
      post: vi.fn(async () => {
        throw new Error("This page was written in: it is kept")
      }),
    }
    markFreshPage("p3")
    expect(await discardIfUntouched(api as never, "p3", { body: "" })).toBe(false)
  })
})
