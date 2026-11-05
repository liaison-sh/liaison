// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import {
  browserOnline,
  connectivitySource,
  createConnectivity,
} from "~/primitives/createConnectivity"

function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { value, configurable: true })
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  setOnLine(true)
})

describe("the browser half", () => {
  it("reads navigator.onLine", () => {
    setOnLine(false)
    expect(browserOnline()).toBe(false)
    setOnLine(true)
    expect(browserOnline()).toBe(true)
  })

  it("follows the online and offline events", () => {
    const source = connectivitySource()
    const seen: boolean[] = []
    const off = source.subscribe((v) => seen.push(v))
    window.dispatchEvent(new Event("offline"))
    window.dispatchEvent(new Event("online"))
    off()
    window.dispatchEvent(new Event("offline"))
    expect(seen).toEqual([false, true])
  })
})

describe("the shell half", () => {
  it("prefers the bridge over navigator.onLine", () => {
    const box: { push: ((online: boolean) => void) | null } = { push: null }
    const onConnectivity = vi.fn((handler: (online: boolean) => void) => {
      box.push = handler
      return () => {
        box.push = null
      }
    })
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = { onConnectivity }

    const source = connectivitySource()
    const seen: boolean[] = []
    const off = source.subscribe((v) => seen.push(v))
    expect(onConnectivity).toHaveBeenCalledTimes(1)
    // The platform knows before navigator.onLine does: a wifi association
    // with no route is still "online" to the webview.
    box.push?.(false)
    expect(seen).toEqual([false])
    off()
    expect(box.push).toBeNull()
  })

  it("survives a bridge that throws or returns no unsubscribe", () => {
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      onConnectivity: () => {
        throw new Error("no network plugin")
      },
    }
    expect(() => connectivitySource().subscribe(() => {})()).not.toThrow()
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      onConnectivity: () => undefined,
    }
    expect(() => connectivitySource().subscribe(() => {})()).not.toThrow()
  })
})

describe("the signal", () => {
  it("starts from the source and follows it", () => {
    const box: { push: ((online: boolean) => void) | null } = { push: null }
    createRoot((dispose) => {
      const online = createConnectivity({
        initial: true,
        subscribe: (handler) => {
          box.push = handler
          return () => {
            box.push = null
          }
        },
      })
      expect(online()).toBe(true)
      box.push?.(false)
      expect(online()).toBe(false)
      box.push?.(true)
      expect(online()).toBe(true)
      dispose()
      // Disposed with its owner: the subscription is gone.
      expect(box.push).toBeNull()
    })
  })

  it("starts offline when the source already is", () => {
    createRoot((dispose) => {
      const online = createConnectivity({ initial: false, subscribe: () => () => {} })
      expect(online()).toBe(false)
      dispose()
    })
  })
})
