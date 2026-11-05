// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression (prod, ticket-10193): after a deploy replaced the hashed assets, a
// session that still held the old module graph could not open a mail
// conversation at all. The tab boundary showed "Something went wrong in this
// tab" over `TypeError: error loading dynamically imported module:
// .../assets/MailConversation-LdzMX3g8.js` and a Try again button that re-ran
// the same doomed import.
import { describe, expect, it, vi } from "vitest"
import { isStaleChunkError, recoverFromStaleChunk } from "~/lib/stale-chunk"

function fakeStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => Object.fromEntries(map),
  }
}

const CHROME_ERR = new TypeError(
  "error loading dynamically imported module: https://liaison.fabrikam.example/assets/MailConversation-LdzMX3g8.js",
)

describe("isStaleChunkError", () => {
  it("recognises the failed-dynamic-import wordings the engines use", () => {
    expect(isStaleChunkError(CHROME_ERR)).toBe(true)
    expect(
      isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: /assets/x.js")),
    ).toBe(true)
    expect(isStaleChunkError(new Error("Importing a module script failed."))).toBe(true)
  })

  it("does not claim an ordinary app error", () => {
    expect(isStaleChunkError(new Error("Cannot read properties of undefined"))).toBe(false)
    expect(isStaleChunkError(undefined)).toBe(false)
    expect(isStaleChunkError({ status: 500 })).toBe(false)
  })
})

describe("recoverFromStaleChunk", () => {
  it("reloads once for a stale chunk and reports that it handled it", () => {
    const reload = vi.fn()
    const storage = fakeStorage()
    expect(recoverFromStaleChunk(CHROME_ERR, { storage, reload, now: () => 1000 })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("does NOT reload a second time inside the retry window — no refresh loop", () => {
    // The whole point of the sentinel: if the reload did not fix it, the tab
    // must show an explanation rather than refresh forever.
    const reload = vi.fn()
    const storage = fakeStorage()
    recoverFromStaleChunk(CHROME_ERR, { storage, reload, now: () => 1000 })
    expect(recoverFromStaleChunk(CHROME_ERR, { storage, reload, now: () => 5000 })).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("reloads again for a LATER deploy, once the window has passed", () => {
    const reload = vi.fn()
    const storage = fakeStorage()
    recoverFromStaleChunk(CHROME_ERR, { storage, reload, now: () => 1000 })
    expect(recoverFromStaleChunk(CHROME_ERR, { storage, reload, now: () => 1000 + 60_000 })).toBe(
      true,
    )
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("leaves an unrelated error alone", () => {
    const reload = vi.fn()
    expect(
      recoverFromStaleChunk(new Error("boom"), { storage: fakeStorage(), reload, now: () => 1 }),
    ).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it("still reloads when session storage throws (private mode)", () => {
    const reload = vi.fn()
    const throwing = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    expect(recoverFromStaleChunk(CHROME_ERR, { storage: throwing, reload, now: () => 1 })).toBe(
      true,
    )
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
