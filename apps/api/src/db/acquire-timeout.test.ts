// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { DbAcquireTimeoutError, withAcquireTimeout } from "~/db/acquire-timeout"

describe("withAcquireTimeout", () => {
  it("resolves with the work's value when it settles before the timeout", async () => {
    const result = await withAcquireTimeout("test-fast", 5_000, Promise.resolve(42))
    expect(result).toBe(42)
  })

  it("rejects fast with DbAcquireTimeoutError when work never settles within timeoutMs", async () => {
    const neverSettles = new Promise<never>(() => {})
    const start = Date.now()
    await expect(withAcquireTimeout("test-slow", 50, neverSettles)).rejects.toThrow(
      DbAcquireTimeoutError,
    )
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it("timeout error message names the reason and timeoutMs", async () => {
    const neverSettles = new Promise<never>(() => {})
    await expect(withAcquireTimeout("my-reason", 20, neverSettles)).rejects.toThrow(
      /my-reason.*20ms|20ms.*my-reason/,
    )
  })

  it("propagates the work's own rejection (not a timeout) when work rejects first", async () => {
    const workError = new Error("deliberate work failure")
    await expect(
      withAcquireTimeout("test-reject", 5_000, Promise.reject(workError)),
    ).rejects.toThrow("deliberate work failure")
  })

  it("timeoutMs <= 0 disables the guard (returns work directly, even if it never settles fast)", async () => {
    const result = await withAcquireTimeout("test-disabled", 0, Promise.resolve("ok"))
    expect(result).toBe("ok")
  })

  it("calls onTimeout exactly once when the timeout wins the race", async () => {
    let calls = 0
    const neverSettles = new Promise<never>(() => {})
    await expect(
      withAcquireTimeout("test-ontimeout", 20, neverSettles, () => {
        calls++
      }),
    ).rejects.toThrow(DbAcquireTimeoutError)
    expect(calls).toBe(1)
  })

  it("does NOT call onTimeout when work settles before the timeout", async () => {
    let calls = 0
    await withAcquireTimeout("test-no-ontimeout", 5_000, Promise.resolve("fine"), () => {
      calls++
    })
    expect(calls).toBe(0)
  })
})
