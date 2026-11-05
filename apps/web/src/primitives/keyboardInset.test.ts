// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import {
  applyKeyboardInset,
  KEYBOARD_INSET_PROPERTY,
  keyboardInset,
  keyboardOpen,
  startKeyboardInset,
} from "~/primitives/keyboardInset"

const root = () => document.documentElement

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  applyKeyboardInset(0)
})

describe("the native keyboard inset", () => {
  it("lands the shell's keyboard height on the root property, attribute and signal", () => {
    // The iOS web view is never told about the keyboard: this subscription is
    // the only thing that can lift the page above it.
    let push: ((inset: number) => void) | undefined
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      onKeyboardInset: (handler: (inset: number) => void) => {
        push = handler
        return () => {}
      },
    }
    startKeyboardInset()
    push?.(336)
    expect(keyboardInset()).toBe(336)
    expect(keyboardOpen()).toBe(true)
    expect(root().style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("336px")
    expect(root().hasAttribute("data-keyboard-open")).toBe(true)

    push?.(0)
    expect(keyboardOpen()).toBe(false)
    expect(root().style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("0px")
    expect(root().hasAttribute("data-keyboard-open")).toBe(false)
  })

  it("is a no-op in a browser, where no shell publishes anything", () => {
    const off = startKeyboardInset()
    expect(typeof off).toBe("function")
    expect(keyboardInset()).toBe(0)
  })

  it("survives a shell whose subscription throws", () => {
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      onKeyboardInset: () => {
        throw new Error("boom")
      },
    }
    expect(() => startKeyboardInset()).not.toThrow()
    expect(keyboardInset()).toBe(0)
  })

  it("reads a nonsense height as nothing covered", () => {
    applyKeyboardInset(Number.NaN)
    expect(keyboardInset()).toBe(0)
    applyKeyboardInset(-40)
    expect(keyboardInset()).toBe(0)
  })
})

describe("the focused field under the native keyboard", () => {
  // The web view is not told about the keyboard, so it never scrolls the
  // field being typed in out from under it: the lift does, for every field.
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
  const field = (inside?: string) => {
    const host = document.createElement("div")
    if (inside) host.setAttribute(inside, "")
    const input = document.createElement("textarea")
    host.append(input)
    document.body.append(host)
    const scroll = vi.fn()
    input.scrollIntoView = scroll
    input.focus()
    return { host, scroll }
  }

  afterEach(() => {
    document.body.replaceChildren()
  })

  it("scrolls the focused field into view when the keyboard comes up", async () => {
    const { scroll } = field()
    applyKeyboardInset(320)
    await nextFrame()
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" })
  })

  it("brings the field's whole form into view, so its submit button clears the keyboard", async () => {
    const form = document.createElement("form")
    const input = document.createElement("input")
    form.append(input, document.createElement("button"))
    document.body.append(form)
    const formScroll = vi.fn()
    const inputScroll = vi.fn()
    form.scrollIntoView = formScroll
    input.scrollIntoView = inputScroll
    form.getBoundingClientRect = () => ({ height: 120 }) as DOMRect
    input.focus()
    applyKeyboardInset(320)
    await nextFrame()
    expect(formScroll).toHaveBeenCalledWith({ block: "nearest" })
    expect(inputScroll).not.toHaveBeenCalled()
  })

  it("reveals the field alone when its form is taller than the area left visible", async () => {
    const form = document.createElement("form")
    const input = document.createElement("input")
    form.append(input)
    document.body.append(form)
    const formScroll = vi.fn()
    const inputScroll = vi.fn()
    form.scrollIntoView = formScroll
    input.scrollIntoView = inputScroll
    form.getBoundingClientRect = () => ({ height: window.innerHeight }) as DOMRect
    input.focus()
    applyKeyboardInset(320)
    await nextFrame()
    expect(inputScroll).toHaveBeenCalledWith({ block: "nearest" })
    expect(formScroll).not.toHaveBeenCalled()
  })

  it("leaves a docked composer to its dock, and a keyboard going down alone", async () => {
    const { scroll } = field("data-composer-dock")
    applyKeyboardInset(320)
    await nextFrame()
    expect(scroll).not.toHaveBeenCalled()

    document.body.replaceChildren()
    const other = field()
    applyKeyboardInset(0)
    await nextFrame()
    expect(other.scroll).not.toHaveBeenCalled()
  })
})
