// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EDGE_SWIPE_MIN_TRAVEL_PX,
  findPhoneBackControl,
  installEdgeSwipeBack,
} from "~/primitives/edgeSwipeBack"

function touch(x: number, y: number, id = 1): Touch {
  return { identifier: id, clientX: x, clientY: y } as Touch
}

function fire(type: string, touches: Touch[], changed: Touch[] = touches): void {
  const event = new Event(type) as Event & { touches: Touch[]; changedTouches: Touch[] }
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : touches })
  Object.defineProperty(event, "changedTouches", { value: changed })
  document.dispatchEvent(event)
}

function swipe(fromX: number, toX: number, dy = 0): void {
  fire("touchstart", [touch(fromX, 300)])
  fire("touchmove", [touch((fromX + toX) / 2, 300 + dy / 2)])
  fire("touchend", [], [touch(toX, 300 + dy)])
}

const visible = (el: HTMLElement) => !el.hasAttribute("data-hidden-for-test")

describe("edge swipe back", () => {
  let uninstall: (() => void) | undefined
  afterEach(() => {
    uninstall?.()
    document.body.innerHTML = ""
  })

  function backButton(id: string, onClick: () => void, hidden = false): HTMLButtonElement {
    const b = document.createElement("button")
    b.setAttribute("data-phone-back", "")
    b.id = id
    if (hidden) b.setAttribute("data-hidden-for-test", "")
    b.addEventListener("click", onClick)
    document.body.append(b)
    return b
  }

  it("a swipe from the left edge presses the back control on screen", () => {
    const back = vi.fn()
    backButton("shell", back)
    uninstall = installEdgeSwipeBack(document, { isVisible: visible })
    swipe(8, 8 + EDGE_SWIPE_MIN_TRAVEL_PX + 10)
    expect(back).toHaveBeenCalledTimes(1)
  })

  it("ignores a drag that starts away from the edge, a short one, and a vertical scroll", () => {
    const back = vi.fn()
    backButton("shell", back)
    uninstall = installEdgeSwipeBack(document, { isVisible: visible })
    swipe(120, 260)
    swipe(8, 40)
    swipe(8, 90, 200)
    expect(back).not.toHaveBeenCalled()
  })

  it("presses the innermost visible back, never a hidden tab's", () => {
    const shell = vi.fn()
    const inner = vi.fn()
    const hidden = vi.fn()
    backButton("shell", shell)
    backButton("inner", inner)
    backButton("kept-alive", hidden, true)
    expect(findPhoneBackControl(document, visible)?.id).toBe("inner")
    uninstall = installEdgeSwipeBack(document, { isVisible: visible })
    swipe(4, 120)
    expect([shell.mock.calls.length, inner.mock.calls.length, hidden.mock.calls.length]).toEqual([
      0, 1, 0,
    ])
  })

  it("does nothing on a screen with no back control", () => {
    uninstall = installEdgeSwipeBack(document, { isVisible: visible })
    expect(() => swipe(4, 120)).not.toThrow()
  })
})
