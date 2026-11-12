// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sidebar rows open their tab through the host navigate. A host may draw
// the sidebar in its own frame, where following a row's href would load the
// path inside that frame ("not found") instead of opening the tab; so a plain
// left click must call navigate(path) and cancel the anchor's default, while
// the href stays for middle-click and assistive tech. The active row must
// also survive a frame, whose window path names no monitoring route.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { activeRoute, MonitoringSidebar, onRowClick } from "./sidebar"

const navigateMock = vi.fn<(path: string) => void>()

vi.mock("@liaison/host", () => ({
  app: {
    invokeTool: async (name: string) =>
      name === "incidents_summary"
        ? {
            data: {
              open: { critical: 0, warning: 1, info: 0, total: 1 },
              acknowledged: 2,
              resolved24h: 0,
              sources: [{ source: "sentry", open: 1, worstSeverity: "warning", lastSeenAt: null }],
              generatedAt: "2026-10-26T00:00:00Z",
              profiles: [],
              warnings: [],
              sourceOrder: ["sentry"],
              monitoringUrl: null,
              canConfigure: false,
            },
          }
        : {},
    createResource: (fetcher: () => unknown) => createResource(fetcher),
  },
  navigate: (path: string) => navigateMock(path),
  // The SDK's own fallback when no host gives the page's path: the window's.
  currentPath: () => `${window.location.pathname}${window.location.search}`,
  hostLocale: () => "en",
  onEntityChange: () => () => {},
}))

beforeEach(() => navigateMock.mockClear())
afterEach(() => cleanup())

/** Dispatch a click and report whether the anchor's default survived. */
function click(el: Element, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
  el.dispatchEvent(event)
  return !event.defaultPrevented
}

describe("MonitoringSidebar rows", () => {
  it("a source row click calls the host navigate with its path and does not follow the href", async () => {
    render(() => <MonitoringSidebar />)
    const row = await screen.findByTestId("monitoring-sidebar-source-sentry")
    expect(row.getAttribute("href")).toBe("/monitoring/source/sentry")
    expect(click(row)).toBe(false)
    expect(navigateMock).toHaveBeenCalledWith("/monitoring/source/sentry")
  })

  it("every incidents row (overview, acknowledged, resolved) goes through the host navigate", async () => {
    render(() => <MonitoringSidebar />)
    for (const [slug, path] of [
      ["dashboard", "/monitoring"],
      ["acknowledged", "/monitoring/status/acknowledged"],
      ["resolved", "/monitoring/status/resolved"],
    ] as const) {
      const row = await screen.findByTestId(`monitoring-sidebar-link-${slug}`)
      expect(row.getAttribute("href")).toBe(path)
      expect(click(row)).toBe(false)
      expect(navigateMock).toHaveBeenLastCalledWith(path)
    }
    expect(navigateMock).toHaveBeenCalledTimes(3)
  })

  it("a modified click keeps the browser's own behavior (new tab, new window)", async () => {
    render(() => <MonitoringSidebar />)
    const row = await screen.findByTestId("monitoring-sidebar-source-sentry")
    expect(click(row, { metaKey: true })).toBe(true)
    expect(click(row, { ctrlKey: true })).toBe(true)
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it("in a frame (window path outside /monitoring) the clicked row becomes the active one", async () => {
    // jsdom's window path is "/", which names no monitoring route: the frame case.
    render(() => <MonitoringSidebar />)
    const row = await screen.findByTestId("monitoring-sidebar-source-sentry")
    expect(row.getAttribute("aria-current")).toBeNull()
    fireEvent.click(row)
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("page"))
    const ack = screen.getByTestId("monitoring-sidebar-link-acknowledged")
    fireEvent.click(ack)
    await waitFor(() => expect(ack.getAttribute("aria-current")).toBe("page"))
    expect(row.getAttribute("aria-current")).toBeNull()
  })
})

describe("activeRoute / onRowClick", () => {
  it("prefers the window path when it is a monitoring route, else the last navigated row", () => {
    expect(activeRoute("/monitoring/source/x", "/monitoring")).toBe("/monitoring/source/x")
    expect(activeRoute("/monitoring", null)).toBe("/monitoring")
    expect(activeRoute("srcdoc", "/monitoring/status/resolved")).toBe("/monitoring/status/resolved")
    expect(activeRoute("/", null)).toBeNull()
    expect(activeRoute("/monitoringx", null)).toBeNull()
  })

  it("ignores non-primary buttons and an already-cancelled event", () => {
    const go = vi.fn()
    const base = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
    }
    onRowClick({ ...base, button: 1, defaultPrevented: false }, "/monitoring", go)
    onRowClick({ ...base, button: 0, defaultPrevented: true }, "/monitoring", go)
    expect(go).not.toHaveBeenCalled()
    onRowClick({ ...base, button: 0, defaultPrevented: false }, "/monitoring", go)
    expect(go).toHaveBeenCalledWith("/monitoring")
  })
})
