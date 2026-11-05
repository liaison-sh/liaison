// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { _resetRegistry, onSessionTeardown, teardownSession } from "./session-lifecycle"

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
