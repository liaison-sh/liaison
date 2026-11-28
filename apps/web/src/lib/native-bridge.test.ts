// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  isNativeShell,
  NATIVE_BRIDGE_GLOBAL,
  nativeAppLock,
  nativeAuthenticate,
  nativeBridge,
  nativeBridgeVersionSupported,
  nativeHaptic,
  nativePushPermission,
  nativeRefreshShell,
  nativeServers,
  nativeSetTheme,
  nativeShellInfo,
  nativeShellReport,
  nativeShellServed,
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

  it("asks the sign-out guards first, and stops on a no; forced tells them so", async () => {
    const { onBeforeSignOut, onSignOutGuard } = await import("~/lib/session-lifecycle")
    const before = vi.fn()
    const disposeBefore = onBeforeSignOut(before)
    let answer = false
    const guard = vi.fn(async () => answer)
    const disposeGuard = onSignOutGuard(guard)
    const signOut = vi.fn(async () => {})
    setBridge({
      servers: { list: vi.fn(), add: vi.fn(), switchTo: vi.fn(), remove: vi.fn(), signOut },
    })
    try {
      await nativeServers()?.signOut()
      expect(guard).toHaveBeenLastCalledWith({ forced: false })
      expect(before).not.toHaveBeenCalled()
      expect(signOut).not.toHaveBeenCalled()
      answer = true
      await nativeServers()?.signOut({ forced: true })
      expect(guard).toHaveBeenLastCalledWith({ forced: true })
      expect(signOut).toHaveBeenCalledTimes(1)
    } finally {
      disposeBefore()
      disposeGuard()
    }
  })
})

describe("the served shell on the phone", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const served = {
    bridgeVersion: 1,
    shell: "served:0123456789abcdef",
    served: true,
    buildId: "0123456789abcdef",
  }

  it("tells the host this build painted, with its build id", async () => {
    const shellReady = vi.fn()
    setBridge({ ready: vi.fn(), shellInfo: async () => served, shellReady })
    signalNativeReady()
    await flush()
    // No document in this environment: no meta, so a null build id.
    expect(shellReady).toHaveBeenCalledWith(null)
  })

  it("stays unconfirmed when the host's bridge is outside this build's range", async () => {
    const shellReady = vi.fn()
    setBridge({ shellInfo: async () => ({ ...served, bridgeVersion: 2 }), shellReady })
    signalNativeReady()
    await flush()
    expect(shellReady).not.toHaveBeenCalled()
    expect(nativeBridgeVersionSupported({ ...served, bridgeVersion: 2 })).toBe(false)
    expect(nativeBridgeVersionSupported(served)).toBe(true)
  })

  it("reports which shell runs, and nothing without a host that knows", async () => {
    setBridge({ shellInfo: async () => served })
    expect(await nativeShellReport()).toBe("served:0123456789abcdef")
    expect(await nativeShellServed()).toBe(true)
    setBridge({
      shellInfo: async () => ({ bridgeVersion: 1, shell: "bundled:no_build", served: false }),
    })
    expect(await nativeShellServed()).toBe(false)
    setBridge({ shellInfo: async () => Promise.reject(new Error("gone")) })
    expect(await nativeShellInfo()).toBeNull()
    setBridge({})
    expect(await nativeShellReport()).toBeNull()
  })

  it("asks the host to choose the build again", async () => {
    setBridge({ refreshShell: async () => true })
    expect(await nativeRefreshShell()).toBe(true)
    setBridge({ refreshShell: async () => Promise.reject(new Error("x")) })
    expect(await nativeRefreshShell()).toBe(false)
    setBridge(null)
    expect(await nativeRefreshShell()).toBe(false)
  })
})
