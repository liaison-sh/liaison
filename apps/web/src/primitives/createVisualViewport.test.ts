// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createVisualViewport } from "~/primitives/createVisualViewport"
import { applyKeyboardInset } from "~/primitives/keyboardInset"

/** A stand-in for `window.visualViewport`: the two numbers the primitive reads
 *  plus the listener registry the browser object exposes. */
function fakeVisualViewport(height: number, offsetTop = 0) {
  const listeners = new Map<string, Set<() => void>>()
  return {
    height,
    offsetTop,
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn)
    },
    emit(type: string) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

describe("createVisualViewport", () => {
  afterEach(() => {
    applyKeyboardInset(0)
    vi.unstubAllGlobals()
    // @ts-expect-error test cleanup of the injected stub
    delete window.visualViewport
  })

  function install(vv: ReturnType<typeof fakeVisualViewport>, innerHeight = 844) {
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true })
    Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true })
  }

  it("reads the initial visual viewport height and offset", () => {
    install(fakeVisualViewport(844))
    createRoot((dispose) => {
      const vp = createVisualViewport()
      expect(vp.height()).toBe(844)
      expect(vp.offsetTop()).toBe(0)
      expect(vp.keyboardInset()).toBe(0)
      dispose()
    })
  })

  it("reacts to a resize: the keyboard opening shrinks the height and reports the inset", () => {
    const vv = fakeVisualViewport(844)
    install(vv, 844)
    createRoot((dispose) => {
      const vp = createVisualViewport()
      expect(vp.height()).toBe(844)

      // 844 layout, 508 visible: a 336px keyboard.
      vv.height = 508
      vv.emit("resize")

      expect(vp.height()).toBe(508)
      expect(vp.keyboardInset()).toBe(336)
      dispose()
    })
  })

  it("reacts to a visual viewport scroll (iOS pans instead of resizing)", () => {
    const vv = fakeVisualViewport(508)
    install(vv, 844)
    createRoot((dispose) => {
      const vp = createVisualViewport()
      vv.offsetTop = 120
      vv.emit("scroll")
      expect(vp.offsetTop()).toBe(120)
      expect(vp.keyboardInset()).toBe(844 - 508 - 120)
      dispose()
    })
  })

  it("drops its listeners when the owning root is disposed", () => {
    const vv = fakeVisualViewport(844)
    install(vv)
    createRoot((dispose) => {
      createVisualViewport()
      expect(vv.listenerCount("resize")).toBe(1)
      expect(vv.listenerCount("scroll")).toBe(1)
      dispose()
      expect(vv.listenerCount("resize")).toBe(0)
      expect(vv.listenerCount("scroll")).toBe(0)
    })
  })

  it("falls back to the layout viewport where visualViewport is absent", () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true })
    createRoot((dispose) => {
      const vp = createVisualViewport()
      expect(vp.height()).toBe(900)
      expect(vp.keyboardInset()).toBe(0)
      dispose()
    })
  })

  it("stops at the native keyboard, which never moves the app's visual viewport", () => {
    // Inside the iOS app the keyboard plugin keeps the notifications from
    // WKWebView: the visual viewport stays at 844 with a 336px keyboard over
    // it. The shell's reported height is what says so.
    install(fakeVisualViewport(844), 844)
    createRoot((dispose) => {
      const vp = createVisualViewport()
      applyKeyboardInset(336)
      expect(vp.height()).toBe(508)
      expect(vp.keyboardInset()).toBe(336)
      applyKeyboardInset(0)
      expect(vp.height()).toBe(844)
      expect(vp.keyboardInset()).toBe(0)
      dispose()
    })
  })
})
