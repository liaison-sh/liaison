// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing's dashboard toolbar at phone width. Bundled-app suites run under
// bun:test with no DOM, so the rendered contract of an app component is pinned
// in this layer (the pattern DetailTab.test.tsx already uses for shopify).
//
// The defect: the date range, three segmented filter groups, the group-by
// switch and Export CSV all wrapped onto a 390px screen and pushed the table
// itself off the first screen. At phone width they collapse behind a Filters
// disclosure; at tablet and desktop width nothing is hidden and there is no
// disclosure at all.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Toolbar } from "../../../../bundled-apps/invoicing/src/ui/dashboards/Toolbar"
import { DEFAULT_FILTER } from "../../../../bundled-apps/invoicing/src/ui/dashboards/types"

/** jsdom ships no matchMedia: every query answers against one viewport width. */
function stubViewport(widthPx: number): void {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query)
    return {
      matches: max ? widthPx <= Number(max[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }
  })
}

function renderToolbar() {
  return render(() => (
    <Toolbar
      filter={DEFAULT_FILTER}
      onChange={() => {}}
      onExportCsv={() => {}}
      trailing={<button type="button" data-testid="probe-trailing" />}
    />
  ))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("the invoicing dashboard toolbar at phone width", () => {
  it("collapses the filter block behind a Filters disclosure", () => {
    stubViewport(390)
    renderToolbar()

    // Search stays: it is the one control worth a permanent seat.
    expect(screen.getByTestId("invoicing-dashboard-search")).toBeTruthy()
    const toggle = screen.getByTestId("invoicing-dashboard-filters-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle.textContent).toContain("Filters")

    expect(screen.queryByTestId("invoicing-dashboard-date-from")).toBeNull()
    expect(screen.queryByTestId("invoicing-dashboard-date-to")).toBeNull()
    expect(screen.queryByTestId("invoicing-dashboard-status-all")).toBeNull()
    expect(screen.queryByTestId("invoicing-dashboard-market-all")).toBeNull()
    expect(screen.queryByTestId("invoicing-dashboard-channel-all")).toBeNull()
    expect(screen.queryByTestId("invoicing-dashboard-export")).toBeNull()
    expect(screen.queryByTestId("probe-trailing")).toBeNull()
  })

  it("reveals the whole block when the disclosure is opened, and closes again", () => {
    stubViewport(390)
    renderToolbar()

    fireEvent.click(screen.getByTestId("invoicing-dashboard-filters-toggle"))
    expect(screen.getByTestId("invoicing-dashboard-filters-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(screen.getByTestId("invoicing-dashboard-date-from")).toBeTruthy()
    expect(screen.getByTestId("invoicing-dashboard-status-all")).toBeTruthy()
    expect(screen.getByTestId("invoicing-dashboard-market-all")).toBeTruthy()
    expect(screen.getByTestId("invoicing-dashboard-channel-all")).toBeTruthy()
    expect(screen.getByTestId("invoicing-dashboard-export")).toBeTruthy()
    expect(screen.getByTestId("probe-trailing")).toBeTruthy()

    fireEvent.click(screen.getByTestId("invoicing-dashboard-filters-toggle"))
    expect(screen.queryByTestId("invoicing-dashboard-date-from")).toBeNull()
  })

  it("keeps every filter expanded at tablet and desktop width, with no disclosure", () => {
    stubViewport(1024)
    renderToolbar()

    expect(screen.queryByTestId("invoicing-dashboard-filters-toggle")).toBeNull()
    expect(screen.getByTestId("invoicing-dashboard-date-from")).toBeTruthy()
    expect(screen.getByTestId("invoicing-dashboard-date-to")).toBeTruthy()
    expect(screen.getByTestId("invoicing-dashboard-status-all")).toBeTruthy()
    expect(screen.getByTestId("invoicing-dashboard-market-all")).toBeTruthy()
    expect(screen.getByTestId("invoicing-dashboard-channel-all")).toBeTruthy()
    expect(screen.getByTestId("invoicing-dashboard-export")).toBeTruthy()
    expect(screen.getByTestId("probe-trailing")).toBeTruthy()
  })
})
