// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  _resetRegistry,
  confirmSignOut,
  onSessionTeardown,
  onSignOutGuard,
  teardownSession,
} from "./session-lifecycle"

beforeEach(() => _resetRegistry())

describe("onSessionTeardown", () => {
  it("registers a teardown that runs on teardownSession", () => {
    const fn = vi.fn()
    onSessionTeardown(fn)
    teardownSession()
    expect(fn).toHaveBeenCalledOnce()
  })

  it("runs multiple teardowns in LIFO order", () => {
    const order: string[] = []
    onSessionTeardown(() => order.push("first"))
    onSessionTeardown(() => order.push("second"))
    onSessionTeardown(() => order.push("third"))
    teardownSession()
    expect(order).toEqual(["third", "second", "first"])
  })

  it("returns a disposer that deregisters the teardown", () => {
    const fn = vi.fn()
    const dispose = onSessionTeardown(fn)
    dispose()
    teardownSession()
    expect(fn).not.toHaveBeenCalled()
  })

  it("isolates failures — one throw does not block others", () => {
    const a = vi.fn()
    const b = vi.fn(() => {
      throw new Error("boom")
    })
    const c = vi.fn()
    onSessionTeardown(a)
    onSessionTeardown(b)
    onSessionTeardown(c)

    // Should not throw
    teardownSession()

    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    expect(c).toHaveBeenCalledOnce()
  })

  it("can be called multiple times (idempotent session boundary)", () => {
    const fn = vi.fn()
    onSessionTeardown(fn)
    teardownSession()
    teardownSession()
    // Teardowns stay registered — they run again each session boundary
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("does not double-register the same function reference", () => {
    const fn = vi.fn()
    onSessionTeardown(fn)
    onSessionTeardown(fn)
    teardownSession()
    expect(fn).toHaveBeenCalledOnce()
  })
})

describe("confirmSignOut", () => {
  it("is yes with no guard, and yes only when every guard says yes", async () => {
    expect(await confirmSignOut()).toBe(true)
    onSignOutGuard(async () => true)
    expect(await confirmSignOut()).toBe(true)
    const no = vi.fn(async () => false)
    const dispose = onSignOutGuard(no)
    expect(await confirmSignOut()).toBe(false)
    dispose()
    expect(await confirmSignOut()).toBe(true)
  })

  it("has no time bound: the person decides", async () => {
    vi.useFakeTimers()
    try {
      let answer: (v: boolean) => void = () => {}
      onSignOutGuard(() => new Promise<boolean>((r) => (answer = r)))
      let settled: boolean | null = null
      void confirmSignOut().then((v) => (settled = v))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(settled).toBeNull()
      answer(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a guard that throws counts as a no, unless the sign-out is forced", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    onSignOutGuard(async () => {
      throw new Error("broken")
    })
    expect(await confirmSignOut()).toBe(false)
    expect(await confirmSignOut({ forced: true })).toBe(true)
  })
})
