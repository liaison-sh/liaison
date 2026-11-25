// SPDX-License-Identifier: FSL-1.1-ALv2
// Where a list under the caret opens: under it while there is room on screen, above
// it otherwise, the room being what the visual viewport shows (on a phone the
// keyboard covers the bottom of the layout viewport).
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { SuggestList } from "./SuggestList"

const original = Object.getOwnPropertyDescriptor(window, "visualViewport")

afterEach(() => {
  cleanup()
  if (original) Object.defineProperty(window, "visualViewport", original)
  else Reflect.deleteProperty(window, "visualViewport")
})

function show(anchor: { left: number; top: number; bottom: number }) {
  render(() => (
    <SuggestList
      testid="list"
      itemTestid="item"
      label="Blocks"
      items={["a", "b"]}
      active={0}
      anchor={anchor}
      width={260}
      rows={9}
      onPick={() => {}}
      option={(x) => <span>{x}</span>}
    />
  ))
  return screen.getByTestId("list")
}

describe("SuggestList placement", () => {
  it("opens under the caret when the screen has room", () => {
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true })
    const list = show({ left: 20, top: 100, bottom: 120 })
    expect(list.style.top).toBe("124px")
    expect(list.style.bottom).toBe("")
  })

  it("opens above the caret when a phone keyboard covers the room under it", () => {
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true })
    // The keyboard takes the bottom 420 px: 424 px are visible.
    Object.defineProperty(window, "visualViewport", {
      value: Object.assign(new EventTarget(), { height: 424, offsetTop: 0, width: 390 }),
      configurable: true,
    })
    const list = show({ left: 20, top: 300, bottom: 320 })
    expect(list.style.top).toBe("")
    expect(list.style.bottom).toBe(`${844 - 300 + 4}px`)
  })

  it("never wider than the screen", () => {
    Object.defineProperty(window, "innerWidth", { value: 200, configurable: true })
    const list = show({ left: 150, top: 10, bottom: 20 })
    expect(list.style.width).toBe("184px")
    expect(list.style.left).toBe("8px")
  })
})
