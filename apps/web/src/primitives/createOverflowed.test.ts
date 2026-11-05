// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { createOverflowed } from "~/primitives/createOverflowed"

/** A box whose content height and visible height are set independently. */
function box(scrollHeight: number, clientHeight: number): HTMLElement {
  const el = document.createElement("div")
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true })
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true })
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("createOverflowed", () => {
  it("is true when the content is taller than the box, whatever its length", () => {
    createRoot((dispose) => {
      // The reported case: 542 characters, well under the old 600 character
      // rule, but every few words on their own line, so it overflowed 320px.
      const el = box(880, 320)
      const { overflowed, update } = createOverflowed(() => el)
      update()
      expect(overflowed()).toBe(true)
      dispose()
    })
  })

  it("is false when the content fits, however many characters it is", () => {
    createRoot((dispose) => {
      const el = box(180, 320)
      const { overflowed, update } = createOverflowed(() => el)
      update()
      expect(overflowed()).toBe(false)
      dispose()
    })
  })

  it("tolerates sub-pixel rounding rather than offering a toggle for one pixel", () => {
    createRoot((dispose) => {
      const el = box(320.5, 320)
      const { overflowed, update } = createOverflowed(() => el)
      update()
      expect(overflowed()).toBe(false)
      dispose()
    })
  })

  it("answers false, not a crash, before the element exists", () => {
    createRoot((dispose) => {
      const { overflowed, update } = createOverflowed(() => undefined)
      update()
      expect(overflowed()).toBe(false)
      dispose()
    })
  })
})
