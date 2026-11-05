// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A picker that opens on its composer's top edge was cut off by whatever clips
// the page above it (the panel's own scroll under the app's top bar) when the
// composer sat near the top. With `fit`, it measures the room it has: it stays
// above when it fits there (or when above is still the larger side, shortened
// to the room), and opens below the composer otherwise.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MentionResult } from "~/lib/mention-service"
import { MentionAutocomplete } from "~/modules/threads/MentionAutocomplete"
import { resetThreadStore } from "~/modules/threads/thread-store"

const results = vi.hoisted(() => ({ value: [] as MentionResult[] }))

vi.mock("~/lib/mention-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/mention-service")>()
  return { ...actual, searchMentions: async () => results.value }
})

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ get: async () => ({ data: [] }) }),
}))

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 400,
    width: 400,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

/** A clipping pane (the panel's scroll) holding the composer at `host`. */
function renderIn(pane: { top: number; bottom: number }, host: { top: number; bottom: number }) {
  render(() => (
    <div data-testid="pane" style={{ overflow: "auto" }}>
      <form data-testid="host" style={{ position: "relative" }}>
        <MentionAutocomplete
          query=""
          trigger="@"
          position={{ bottom: "100%", left: 12 }}
          fit
          onSelect={() => {}}
          onClose={() => {}}
        />
      </form>
    </div>
  ))
  screen.getByTestId("pane").getBoundingClientRect = () => rect(pane.top, pane.bottom)
  screen.getByTestId("host").getBoundingClientRect = () => rect(host.top, host.bottom)
}

const list = (popup: HTMLElement) => popup.querySelector<HTMLElement>("[data-mention-list]")

describe("mention picker that fits its room", () => {
  beforeEach(() => {
    resetThreadStore()
    vi.stubGlobal("innerHeight", 900)
    results.value = [{ type: "user", id: "u-1", label: "Ada Fabrikam" }]
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    resetThreadStore()
  })

  it("opens upward on the composer's top edge when the room above holds it", async () => {
    renderIn({ top: 60, bottom: 900 }, { top: 700, bottom: 820 })
    const popup = await screen.findByTestId("mention-autocomplete")
    await waitFor(() => expect(popup.dataset.placement).toBe("above"))
    expect(popup.style.bottom).toBe("100%")
    expect(list(popup)?.style.maxHeight).toBe("240px")
  })

  it("opens below the composer when the pane clips the room above it", async () => {
    // The composer sits just under the pane's top (under the app's top bar).
    renderIn({ top: 60, bottom: 900 }, { top: 90, bottom: 210 })
    const popup = await screen.findByTestId("mention-autocomplete")
    await waitFor(() => expect(popup.dataset.placement).toBe("below"))
    expect(popup.style.top).toBe("100%")
    expect(popup.style.bottom).toBe("")
  })

  it("stays above, shortened to the room, when above is still the larger side", async () => {
    renderIn({ top: 60, bottom: 900 }, { top: 260, bottom: 860 })
    const popup = await screen.findByTestId("mention-autocomplete")
    await waitFor(() => expect(popup.dataset.placement).toBe("above"))
    const max = Number.parseInt(list(popup)?.style.maxHeight ?? "", 10)
    expect(max).toBeGreaterThan(100)
    expect(max).toBeLessThan(200)
  })
})
