// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { describe, expect, it, vi } from "vitest"
import {
  APP_LOCK_GRACE_MS,
  type AppLockOptions,
  createAppLock,
  shouldLockOnResume,
} from "~/lib/app-lock"
import type { NativeAppLock } from "~/lib/native-bridge"

function fakeLock(overrides: Partial<NativeAppLock> = {}): {
  lock: NativeAppLock
  push: (active: boolean) => void
  unsubscribed: () => boolean
} {
  let handler: ((active: boolean) => void) | null = null
  let off = false
  const lock: NativeAppLock = {
    isAvailable: async () => true,
    getEnabled: async () => true,
    setEnabled: async () => {},
    authenticate: async () => true,
    onAppStateChange: (h) => {
      handler = h
      return () => {
        off = true
        handler = null
      }
    },
    ...overrides,
  }
  return { lock, push: (active) => handler?.(active), unsubscribed: () => off }
}

function withLock<T>(options: AppLockOptions, body: (lock: ReturnType<typeof createAppLock>) => T) {
  let result!: T
  const dispose = createRoot((d) => {
    result = body(createAppLock(options))
    return d
  })
  return { result, dispose }
}

describe("the background grace period", () => {
  it("does not lock for a quick trip to another app", () => {
    expect(shouldLockOnResume(0, APP_LOCK_GRACE_MS - 1)).toBe(false)
  })

  it("locks once the app has been away long enough", () => {
    expect(shouldLockOnResume(0, APP_LOCK_GRACE_MS)).toBe(true)
  })

  it("never locks for a state change that was not a backgrounding", () => {
    expect(shouldLockOnResume(null, 10_000_000)).toBe(false)
  })
})

describe("in a plain browser", () => {
  it("is never locked and reports itself unsupported", () => {
    const { result, dispose } = withLock({ lock: null }, (l) => l)
    expect(result.supported).toBe(false)
    expect(result.locked()).toBe(false)
    dispose()
  })
})

describe("under a shell", () => {
  it("STARTS LOCKED, so the workspace is never painted before the preference answers", () => {
    const { lock } = fakeLock()
    const { result, dispose } = withLock({ lock }, (l) => l)
    expect(result.locked()).toBe(true)
    dispose()
  })

  it("unlocks itself when the preference turns out to be off", async () => {
    const { lock } = fakeLock({ getEnabled: async () => false })
    const { result, dispose } = withLock({ lock }, (l) => l)
    await new Promise((r) => setTimeout(r, 0))
    expect(result.locked()).toBe(false)
    dispose()
  })

  it("unlocks rather than walling the user out when the preference cannot be read", async () => {
    const { lock } = fakeLock({
      getEnabled: async () => {
        throw new Error("preferences unavailable")
      },
    })
    const { result, dispose } = withLock({ lock }, (l) => l)
    await new Promise((r) => setTimeout(r, 0))
    expect(result.locked()).toBe(false)
    dispose()
  })

  it("clears the lock only on a real biometric success", async () => {
    const authenticate = vi.fn(async () => false)
    const { lock } = fakeLock({ authenticate })
    const { result, dispose } = withLock({ lock }, (l) => l)
    await expect(result.unlock("Unlock")).resolves.toBe(false)
    expect(result.locked()).toBe(true)
    authenticate.mockResolvedValue(true)
    await expect(result.unlock("Unlock")).resolves.toBe(true)
    expect(result.locked()).toBe(false)
    dispose()
  })

  it("treats a throwing authenticate as a refusal", async () => {
    const { lock } = fakeLock({
      authenticate: async () => {
        throw new Error("no sensor")
      },
    })
    const { result, dispose } = withLock({ lock }, (l) => l)
    await expect(result.unlock("Unlock")).resolves.toBe(false)
    expect(result.locked()).toBe(true)
    dispose()
  })
})

describe("locking again on resume", () => {
  it("does not ask for a face after a quick trip out of the app", async () => {
    let now = 1_000_000
    const { lock, push } = fakeLock({ getEnabled: async () => false })
    const { result, dispose } = withLock({ lock, now: () => now }, (l) => l)
    await new Promise((r) => setTimeout(r, 0))
    expect(result.locked()).toBe(false)

    push(false)
    now += 30_000
    push(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(result.locked()).toBe(false)
    dispose()
  })

  it("locks after five minutes away, when the preference is on", async () => {
    let now = 1_000_000
    let enabled = false
    const { lock, push } = fakeLock({ getEnabled: async () => enabled })
    const { result, dispose } = withLock({ lock, now: () => now }, (l) => l)
    await new Promise((r) => setTimeout(r, 0))
    expect(result.locked()).toBe(false)

    enabled = true
    push(false)
    now += APP_LOCK_GRACE_MS
    push(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(result.locked()).toBe(true)
    dispose()
  })

  it("does not lock after five minutes away when the preference is off", async () => {
    let now = 1_000_000
    const { lock, push } = fakeLock({ getEnabled: async () => false })
    const { result, dispose } = withLock({ lock, now: () => now }, (l) => l)
    await new Promise((r) => setTimeout(r, 0))

    push(false)
    now += APP_LOCK_GRACE_MS * 10
    push(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(result.locked()).toBe(false)
    dispose()
  })

  it("drops its subscription with its owner", () => {
    const { lock, unsubscribed } = fakeLock()
    const { dispose } = withLock({ lock }, (l) => l)
    expect(unsubscribed()).toBe(false)
    dispose()
    expect(unsubscribed()).toBe(true)
  })
})
