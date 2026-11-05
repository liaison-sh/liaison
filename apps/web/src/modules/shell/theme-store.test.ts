// SPDX-License-Identifier: FSL-1.1-ALv2

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createRoot } from "solid-js"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import {
  createThemeStore,
  getThemeStore,
  startThemeSync,
  ThemeStoreTestAccess,
} from "./theme-store"

function mockMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    matches: prefersDark,
    addEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb)
    },
    removeEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.delete(cb)
    },
    _flip: (next: boolean) => {
      mql.matches = next
      listeners.forEach((cb) => {
        cb({ matches: next } as MediaQueryListEvent)
      })
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).matchMedia = vi.fn(() => mql as any)
  return mql
}

describe("theme-store", () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute("data-theme")
    ThemeStoreTestAccess.reset()
  })

  test("setPreference('light') writes localStorage and data-theme", () => {
    mockMatchMedia(true)
    createRoot((dispose) => {
      const store = createThemeStore()
      store.setPreference("light")
      expect(localStorage.getItem("liaison:theme")).toBe("light")
      expect(document.documentElement.getAttribute("data-theme")).toBe("light")
      expect(store.resolved()).toBe("light")
      dispose()
    })
  })

  test("setPreference('system') reacts to OS pref flips", () => {
    const mql = mockMatchMedia(false)
    createRoot((dispose) => {
      const store = createThemeStore()
      store.setPreference("system")
      expect(store.resolved()).toBe("light")
      mql._flip(true)
      expect(store.resolved()).toBe("dark")
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark")
      dispose()
    })
  })

  test("OS pref flip is ignored while preference is concrete", () => {
    const mql = mockMatchMedia(false)
    createRoot((dispose) => {
      const store = createThemeStore()
      store.setPreference("light")
      mql._flip(true)
      expect(store.resolved()).toBe("light")
      dispose()
    })
  })

  test("hydrateFromServer overwrites local preference and persists", () => {
    localStorage.setItem("liaison:theme", "light")
    mockMatchMedia(false)
    createRoot((dispose) => {
      const store = createThemeStore()
      store.hydrateFromServer("dark")
      expect(localStorage.getItem("liaison:theme")).toBe("dark")
      expect(store.resolved()).toBe("dark")
      expect(store.preference()).toBe("dark")
      dispose()
    })
  })

  test("preference()/resolved() distinguish 'system' from concrete values", () => {
    mockMatchMedia(true)
    createRoot((dispose) => {
      const store = createThemeStore()
      store.setPreference("system")
      expect(store.preference()).toBe("system")
      expect(store.resolved()).toBe("dark")
      dispose()
    })
  })

  test("matchMedia listener is removed on root dispose", () => {
    const mql = mockMatchMedia(false)
    const addSpy = vi.spyOn(mql, "addEventListener")
    const removeSpy = vi.spyOn(mql, "removeEventListener")
    createRoot((dispose) => {
      createThemeStore()
      expect(addSpy).toHaveBeenCalled()
      dispose()
    })
    expect(removeSpy).toHaveBeenCalled()
  })

  describe("native status bar sync", () => {
    let pushed: string[]
    beforeEach(() => {
      pushed = []
      ;(window as any)[NATIVE_BRIDGE_GLOBAL] = { setTheme: (t: string) => pushed.push(t) }
    })

    test("boot pushes the resolved theme before any settings screen mounts", () => {
      mockMatchMedia(false)
      startThemeSync()
      expect(pushed).toEqual(["light"])
    })

    test("the app entry starts the sync before its first render", () => {
      const entry = readFileSync(resolve(__dirname, "..", "..", "index.tsx"), "utf-8")
      const start = entry.indexOf("startThemeSync()")
      expect(start).toBeGreaterThan(-1)
      expect(start).toBeLessThan(entry.indexOf("render("))
    })

    test("an OS appearance flip still reaches the shell after the screen that first read the store unmounts", () => {
      const mql = mockMatchMedia(false)
      createRoot((dispose) => {
        getThemeStore()
        dispose()
      })
      mql._flip(true)
      expect(pushed.at(-1)).toBe("dark")
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark")
    })
  })
})
