// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import config from "../../capacitor.config"
import {
  NATIVE_BRIDGE_GLOBAL,
  publishedNativeBridge,
  publishNativeBridge,
} from "../bridge/native-bridge"
import type { AppStatePlugin } from "./app-lock"
import { createForeground } from "./foreground"
import { createSplashGate, SPLASH_FALLBACK_MS } from "./splash"
import { createStatusBarController, type StatusBarPlugin, statusBarStyleFor } from "./status-bar"

describe("the bridge published for the wrapped app", () => {
  it("publishes the members it is given", () => {
    const target: Record<string, unknown> = {}
    const ready = () => {}
    publishNativeBridge(target, { ready })
    expect(publishedNativeBridge(target)?.ready).toBe(ready)
  })

  it("merges a later part without dropping an earlier one", () => {
    const target: Record<string, unknown> = {}
    const ready = () => {}
    const first = publishNativeBridge(target, { ready })
    const haptic = () => {}
    const second = publishNativeBridge(target, { haptic })
    // The SAME object: the wrapped app may have captured it already.
    expect(second).toBe(first)
    expect(second.ready).toBe(ready)
    expect(second.haptic).toBe(haptic)
  })

  it("replaces a non-object somebody else left on the global", () => {
    const target: Record<string, unknown> = { [NATIVE_BRIDGE_GLOBAL]: "hijacked" }
    const ready = () => {}
    publishNativeBridge(target, { ready })
    expect(publishedNativeBridge(target)?.ready).toBe(ready)
  })

  it("answers null before anything has published", () => {
    expect(publishedNativeBridge({})).toBeNull()
  })
})

function recordingStatusBar(): { plugin: StatusBarPlugin; styles: string[]; overlays: boolean[] } {
  const styles: string[] = []
  const overlays: boolean[] = []
  return {
    styles,
    overlays,
    plugin: {
      setStyle: async ({ style }) => {
        styles.push(style)
      },
      setOverlaysWebView: async ({ overlay }) => {
        overlays.push(overlay)
      },
    },
  }
}

describe("the status bar following the app theme", () => {
  it("asks for light glyphs on a dark app and dark glyphs on a light one", () => {
    expect(statusBarStyleFor("dark")).toBe("DARK")
    expect(statusBarStyleFor("light")).toBe("LIGHT")
  })

  it("sets the style the theme resolves to", async () => {
    const bar = recordingStatusBar()
    createStatusBarController(bar.plugin).setTheme("dark")
    await Promise.resolve()
    expect(bar.styles).toEqual(["DARK"])
  })

  it("makes one native call per actual change, not per push", async () => {
    const bar = recordingStatusBar()
    const controller = createStatusBarController(bar.plugin)
    controller.setTheme("dark")
    controller.setTheme("dark")
    controller.setTheme("light")
    controller.setTheme("light")
    controller.setTheme("dark")
    await Promise.resolve()
    expect(bar.styles).toEqual(["DARK", "LIGHT", "DARK"])
  })

  it("overlays the web view so the app keeps its own safe-area padding", async () => {
    const bar = recordingStatusBar()
    await createStatusBarController(bar.plugin).start()
    expect(bar.overlays).toEqual([true])
  })

  it("survives a plugin that rejects", async () => {
    const plugin: StatusBarPlugin = {
      setStyle: async () => {
        throw new Error("no status bar on this platform")
      },
      setOverlaysWebView: async () => {
        throw new Error("no status bar on this platform")
      },
    }
    const controller = createStatusBarController(plugin)
    expect(() => controller.setTheme("dark")).not.toThrow()
    await expect(controller.start()).resolves.toBeUndefined()
  })
})

function fakeTimers(): {
  setTimer: (handler: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  fire: () => void
  armedFor: () => number | null
  cleared: () => number
} {
  let pending: (() => void) | null = null
  let ms: number | null = null
  let cleared = 0
  return {
    setTimer: (handler, delay) => {
      pending = handler
      ms = delay
      return 1
    },
    clearTimer: () => {
      cleared++
      pending = null
    },
    fire: () => pending?.(),
    armedFor: () => ms,
    cleared: () => cleared,
  }
}

function countingSplash(): { plugin: { hide: () => Promise<void> }; hides: () => number } {
  let hides = 0
  return {
    plugin: {
      hide: async () => {
        hides++
      },
    },
    hides: () => hides,
  }
}

describe("the splash screen gate", () => {
  it("hides when the app says it has painted", () => {
    const splash = countingSplash()
    const gate = createSplashGate({ plugin: splash.plugin })
    expect(gate.hidden()).toBe(false)
    gate.ready()
    expect(splash.hides()).toBe(1)
    expect(gate.hidden()).toBe(true)
  })

  it("hides exactly once however many times the app says it is ready", () => {
    const splash = countingSplash()
    const gate = createSplashGate({ plugin: splash.plugin })
    gate.ready()
    gate.ready()
    gate.ready()
    expect(splash.hides()).toBe(1)
  })

  it("hides on the fallback when the app never says it is ready", () => {
    const splash = countingSplash()
    const timers = fakeTimers()
    const gate = createSplashGate({
      plugin: splash.plugin,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    gate.arm()
    expect(timers.armedFor()).toBe(SPLASH_FALLBACK_MS)
    expect(splash.hides()).toBe(0)
    timers.fire()
    expect(splash.hides()).toBe(1)
  })

  it("drops the fallback once the app has painted, so it hides only once", () => {
    const splash = countingSplash()
    const timers = fakeTimers()
    const gate = createSplashGate({
      plugin: splash.plugin,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    gate.arm()
    gate.ready()
    expect(timers.cleared()).toBe(1)
    timers.fire()
    expect(splash.hides()).toBe(1)
  })

  it("arms one timer however many times it is armed", () => {
    const splash = countingSplash()
    const timers = fakeTimers()
    const gate = createSplashGate({
      plugin: splash.plugin,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    gate.arm()
    gate.arm()
    gate.ready()
    expect(timers.cleared()).toBe(1)
    expect(splash.hides()).toBe(1)
  })
})

describe("the native shelf's Capacitor configuration", () => {
  it("never auto-hides the splash, so only the app can take it down", () => {
    expect(config.plugins?.SplashScreen?.launchAutoHide).toBe(false)
  })

  it("paints the splash in the app's own background colour", () => {
    expect(config.plugins?.SplashScreen?.backgroundColor).toBe("#111113")
  })

  it("overlays the status bar, so the app keeps its own safe-area padding", () => {
    expect(config.plugins?.StatusBar?.overlaysWebView).toBe(true)
  })
})

describe("the foreground hook (S26)", () => {
  function fakeAppState(opts: { deferSubscribe?: boolean } = {}) {
    let handler: ((state: { isActive: boolean }) => void) | null = null
    let release: (() => void) | null = null
    let removed = 0
    const plugin: AppStatePlugin = {
      addListener: async (_event, h) => {
        handler = h
        if (opts.deferSubscribe) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return {
          remove: async () => {
            removed++
            handler = null
          },
        }
      },
    }
    return {
      plugin,
      emit: (isActive: boolean) => handler?.({ isActive }),
      settle: async () => {
        release?.()
        for (let i = 0; i < 4; i++) await Promise.resolve()
      },
      removed: () => removed,
    }
  }

  it("onForeground fires on appStateChange active and unsubscribes synchronously", async () => {
    const app = fakeAppState()
    let fired = 0
    const off = createForeground(app.plugin)(() => fired++)
    await app.settle()
    app.emit(false)
    expect(fired).toBe(0)
    app.emit(true)
    expect(fired).toBe(1)
    off()
    // The handler is dead the moment the unsubscribe returns.
    app.emit(true)
    expect(fired).toBe(1)
    await app.settle()
    expect(app.removed()).toBe(1)
  })

  it("an unsubscribe before the plugin answered removes the listener when it arrives", async () => {
    const app = fakeAppState({ deferSubscribe: true })
    let fired = 0
    const off = createForeground(app.plugin)(() => fired++)
    off()
    app.emit(true)
    await app.settle()
    expect(fired).toBe(0)
    expect(app.removed()).toBe(1)
  })
})
