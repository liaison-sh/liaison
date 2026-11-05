// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import config from "../../capacitor.config"
import {
  createKeyboardInset,
  hideKeyboardAccessoryBar,
  type KeyboardEventsPlugin,
  type KeyboardPlugin,
} from "./keyboard"

describe("the keyboard configuration", () => {
  it("leaves the resize to the web app's own lift", () => {
    // Anything but "none" makes the native side correct for the keyboard TOO,
    // on top of the inset published below, and the composer lifts twice.
    expect(String(config.plugins?.Keyboard?.resize)).toBe("none")
  })
})

describe("the accessory bar", () => {
  it("is hidden: the composer already carries its own controls", async () => {
    const calls: boolean[] = []
    const plugin: KeyboardPlugin = {
      setAccessoryBarVisible: async ({ isVisible }) => {
        calls.push(isVisible)
      },
    }
    await hideKeyboardAccessoryBar(plugin)
    expect(calls).toEqual([false])
  })

  it("survives the platforms that have no such bar", async () => {
    const plugin: KeyboardPlugin = {
      setAccessoryBarVisible: async () => {
        throw new Error("not implemented on android")
      },
    }
    await expect(hideKeyboardAccessoryBar(plugin)).resolves.toBeUndefined()
  })
})

/** A stand-in plugin that records its listeners and can fire them. */
function fakeKeyboard() {
  const listeners = new Map<string, (info?: unknown) => void>()
  let removed = 0
  const plugin = {
    addListener: (event: string, handler: (info?: unknown) => void) => {
      listeners.set(event, handler)
      return Promise.resolve({
        remove: async () => {
          removed += 1
          listeners.delete(event)
        },
      })
    },
  } as unknown as KeyboardEventsPlugin
  return {
    plugin,
    fire: (event: string, info?: unknown) => listeners.get(event)?.(info),
    removed: () => removed,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the keyboard inset on the bridge", () => {
  it("reports the plugin's height as the keyboard opens and 0 as it goes away", async () => {
    // The web view never sees the keyboard (the plugin takes its
    // notifications), so this is the only place the height comes from.
    const kb = fakeKeyboard()
    const seen: number[] = []
    createKeyboardInset(kb.plugin)((inset) => seen.push(inset))
    await settle()
    kb.fire("keyboardWillShow", { keyboardHeight: 336 })
    kb.fire("keyboardWillHide")
    expect(seen).toEqual([336, 0])
  })

  it("reads a missing or nonsense height as nothing covered", async () => {
    const kb = fakeKeyboard()
    const seen: number[] = []
    createKeyboardInset(kb.plugin)((inset) => seen.push(inset))
    await settle()
    kb.fire("keyboardWillShow", {})
    kb.fire("keyboardWillShow", { keyboardHeight: -5 })
    expect(seen).toEqual([0, 0])
  })

  it("stops, and drops both listeners, once unsubscribed", async () => {
    const kb = fakeKeyboard()
    const seen: number[] = []
    const off = createKeyboardInset(kb.plugin)((inset) => seen.push(inset))
    await settle()
    off()
    kb.fire("keyboardWillShow", { keyboardHeight: 336 })
    expect(seen).toEqual([])
    expect(kb.removed()).toBe(2)
  })

  it("drops listeners that register after an early unsubscribe", async () => {
    const kb = fakeKeyboard()
    const off = createKeyboardInset(kb.plugin)(() => {})
    off()
    await settle()
    expect(kb.removed()).toBe(2)
  })
})
