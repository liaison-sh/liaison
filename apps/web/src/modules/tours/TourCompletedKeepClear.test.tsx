// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Walk D58: at 1280 the completion card (top right, it stays until the visitor
// acts) sat over the open scenario list and hid a Start button. A surface that
// marks itself `data-tour-keep-clear` keeps the card below it on desktop, and
// the card goes back up once that surface closes.
import { defineTour, type TourProgress } from "@liaison/shared"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { TourCompleted } from "./TourPanel"

const tour = defineTour({
  id: "kernel.demo",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "a",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
    },
  ],
})

const progress: TourProgress = {
  tourId: tour.id,
  status: "completed",
  beatId: null,
  beatIndex: 1,
  beatCount: 1,
  beatStates: {},
  source: "help",
  startedAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
}

function keepClear(rect: { top: number; bottom: number; left: number; right: number }) {
  const el = document.createElement("section")
  el.setAttribute("data-tour-keep-clear", "")
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => ({}),
    }) as DOMRect
  document.body.appendChild(el)
  return el
}

function card(phone = false) {
  render(() => (
    <I18nProvider initialLocale="en">
      <TourCompleted tour={tour} progress={progress} phone={phone} />
    </I18nProvider>
  ))
  return screen.getByTestId("tour-completed")
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  for (const el of document.querySelectorAll("[data-tour-keep-clear]")) el.remove()
})

describe("the completion card keeps clear of the scenario list", () => {
  it("sits below an open list under the banner at 1280", () => {
    keepClear({ top: 66, bottom: 236, left: 308, right: 1280 })
    expect(card().style.top).toBe("244px")
  })

  it("goes back to the top once the list closes, and moves down when it opens", () => {
    const el = card()
    expect(el.style.top).toBe("64px")
    const list = keepClear({ top: 66, bottom: 236, left: 308, right: 1280 })
    vi.advanceTimersByTime(500)
    expect(el.style.top).toBe("244px")
    list.remove()
    vi.advanceTimersByTime(500)
    expect(el.style.top).toBe("64px")
  })

  it("ignores a surface that is not under the card's column", () => {
    keepClear({ top: 66, bottom: 236, left: 0, right: 600 })
    expect(card().style.top).toBe("64px")
  })
})
