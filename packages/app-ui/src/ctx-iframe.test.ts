// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, mock } from "bun:test"
import { createIframeBridge } from "./ctx-iframe"

// Reset the dev escape-hatch flag between tests so one test enabling it can't
// leak into another.
afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: deleting an optional global test flag
  delete (globalThis as any).LIAISON_DEV
})

describe("createIframeBridge — targetOrigin hardening", () => {
  it('rejects the wildcard "*" targetOrigin (would broadcast cross-origin)', () => {
    const postMessage = mock(() => {})
    expect(() => createIframeBridge({ postMessage, targetOrigin: "*" })).toThrow(/\*/)
    // Construction failed, so no message channel exists — nothing was posted.
    expect(postMessage).not.toHaveBeenCalled()
  })

  it("rejects an empty targetOrigin", () => {
    const postMessage = mock(() => {})
    expect(() => createIframeBridge({ postMessage, targetOrigin: "" })).toThrow(/concrete origin/i)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it("rejects a path-bearing (non-bare) origin", () => {
    const postMessage = mock(() => {})
    expect(() =>
      createIframeBridge({ postMessage, targetOrigin: "https://host.example/embed" }),
    ).toThrow(/bare origin/i)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it("rejects a value that is not a URL at all", () => {
    const postMessage = mock(() => {})
    expect(() => createIframeBridge({ postMessage, targetOrigin: "host.example" })).toThrow(
      /concrete origin/i,
    )
    expect(postMessage).not.toHaveBeenCalled()
  })

  it("accepts a concrete scheme://host origin and uses it as targetOrigin", () => {
    const postMessage = mock((_msg: string, _origin: string) => {})
    const ctx = createIframeBridge({
      postMessage,
      targetOrigin: "https://app.example.com",
    })
    ctx.showToast("hello", "info")
    expect(postMessage).toHaveBeenCalledTimes(1)
    const [msg, origin] = postMessage.mock.calls[0]
    expect(origin).toBe("https://app.example.com")
    expect(JSON.parse(msg as string)).toEqual({
      type: "toast",
      payload: { message: "hello", variant: "info" },
    })
  })

  it("accepts a concrete origin with an explicit port (localhost dev)", () => {
    const postMessage = mock((_msg: string, _origin: string) => {})
    const ctx = createIframeBridge({
      postMessage,
      targetOrigin: "http://localhost:5173",
    })
    ctx.openTab("thread", "t1", "Thread")
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage.mock.calls[0][1]).toBe("http://localhost:5173")
  })

  it('permits the wildcard "*" ONLY when globalThis.LIAISON_DEV === true', () => {
    // biome-ignore lint/suspicious/noExplicitAny: setting an optional global test flag
    ;(globalThis as any).LIAISON_DEV = true
    const postMessage = mock((_msg: string, _origin: string) => {})
    const ctx = createIframeBridge({ postMessage, targetOrigin: "*" })
    ctx.closeTab()
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage.mock.calls[0][1]).toBe("*")
  })
})
