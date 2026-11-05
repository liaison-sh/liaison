// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  isNativeShell,
  NATIVE_BRIDGE_GLOBAL,
  nativeAppLock,
  nativeAuthenticate,
  nativeBridge,
  nativeHaptic,
  nativePushPermission,
  nativeServers,
  nativeSetTheme,
  signalNativeReady,
} from "~/lib/native-bridge"

function setBridge(value: unknown): void {
  ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = value
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
})

describe("the native bridge in a plain browser", () => {
  it("reports no shell and no bridge", () => {
    expect(nativeBridge()).toBeNull()
    expect(isNativeShell()).toBe(false)
    expect(nativeAppLock()).toBeNull()
  })

  it("makes every call a no-op rather than an exception", () => {
    expect(() => signalNativeReady()).not.toThrow()
    expect(() => nativeSetTheme("dark")).not.toThrow()
    expect(() => nativeHaptic("selection")).not.toThrow()
  })
})

describe("the native bridge under a shell", () => {
  it("calls ready, setTheme and haptic through to the shell", () => {
    const ready = vi.fn()
    const setTheme = vi.fn()
    const haptic = vi.fn()
    setBridge({ ready, setTheme, haptic })

    expect(isNativeShell()).toBe(true)
    signalNativeReady()
    nativeSetTheme("dark")
    nativeHaptic("success")

    expect(ready).toHaveBeenCalledTimes(1)
    expect(setTheme).toHaveBeenCalledWith("dark")
    expect(haptic).toHaveBeenCalledWith("success")
  })

  it("swallows a bridge function that throws", () => {
    setBridge({
      ready: () => {
        throw new Error("no splash plugin")
      },
      haptic: () => {
        throw new Error("no motor")
      },
      setTheme: () => {
        throw new Error("no status bar")
      },
    })
    expect(() => signalNativeReady()).not.toThrow()
    expect(() => nativeHaptic("light")).not.toThrow()
    expect(() => nativeSetTheme("light")).not.toThrow()
  })

  it("ignores a member that is not a function", () => {
    setBridge({ ready: "yes", haptic: 3, setTheme: null })
    expect(() => signalNativeReady()).not.toThrow()
    expect(() => nativeHaptic("error")).not.toThrow()
    expect(() => nativeSetTheme("dark")).not.toThrow()
  })

  it("ignores a global that is not an object", () => {
    setBridge("__LIAISON_NATIVE__")
    expect(nativeBridge()).toBeNull()
    expect(isNativeShell()).toBe(false)
  })

  it("answers an older shell that publishes only some members", () => {
    const haptic = vi.fn()
    setBridge({ haptic })
    signalNativeReady()
    nativeSetTheme("light")
    nativeHaptic("warning")
    expect(haptic).toHaveBeenCalledWith("warning")
  })
})

describe("the app lock member", () => {
  it("is null unless it really carries an authenticate function", () => {
    setBridge({ appLock: {} })
    expect(nativeAppLock()).toBeNull()
    setBridge({ appLock: "yes" })
    expect(nativeAppLock()).toBeNull()
  })

  it("is returned when the shell published one", () => {
    const authenticate = vi.fn(async () => true)
    setBridge({ appLock: { authenticate } })
    expect(nativeAppLock()?.authenticate).toBe(authenticate)
  })
})

describe("the authentication session on the bridge", () => {
  it("is null in a browser and when the member is not a function", () => {
    expect(nativeAuthenticate()).toBeNull()
    setBridge({ authenticate: "nope" })
    expect(nativeAuthenticate()).toBeNull()
  })

  it("is the shell's function when published", async () => {
    const authenticate = vi.fn(async () => "liaison://oauth-complete?code=c&state=s")
    setBridge({ authenticate })
    const run = nativeAuthenticate()
    expect(await run?.({ url: "https://x.example/a", callbackScheme: "liaison" })).toBe(
      "liaison://oauth-complete?code=c&state=s",
    )
    expect(authenticate).toHaveBeenCalledWith({
      url: "https://x.example/a",
      callbackScheme: "liaison",
    })
  })
})

describe("the phone's push permission on the bridge", () => {
  it("is null in a browser and when the member is not an object of functions", () => {
    expect(nativePushPermission()).toBeNull()
    setBridge({ pushPermission: "granted" })
    expect(nativePushPermission()).toBeNull()
    setBridge({ pushPermission: { check: () => Promise.resolve("granted") } })
    expect(nativePushPermission()).toBeNull()
  })

  it("reads and requests through the shell", async () => {
    const check = vi.fn(async () => "prompt" as const)
    const request = vi.fn(async () => "granted" as const)
    setBridge({ pushPermission: { check, request } })
    const permission = nativePushPermission()
    expect(permission).not.toBeNull()
    expect(await permission!.check()).toBe("prompt")
    expect(await permission!.request()).toBe("granted")
    expect(check).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe("the phone's sign out", () => {
  it("runs the page's before-sign-out work before the shell signs out", async () => {
    const { onBeforeSignOut } = await import("~/lib/session-lifecycle")
    const order: string[] = []
    const dispose = onBeforeSignOut(async () => {
      order.push("before")
    })
    const signOut = vi.fn(async () => {
      order.push("shell")
    })
    setBridge({
      servers: {
        list: vi.fn(),
        add: vi.fn(),
        switchTo: vi.fn(),
        remove: vi.fn(),
        signOut,
      },
    })
    try {
      await nativeServers()?.signOut()
      expect(order).toEqual(["before", "shell"])
    } finally {
      dispose()
    }
  })
})
