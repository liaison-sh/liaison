// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The copy control on each connect block sits on one line with the block's
 * own label. Rendered at the Button's DEFAULT size it took the full width of
 * that line, pushing the label off its own row: the control has to be the
 * small action it looks like everywhere else in settings.
 *
 * Small is not the same as invisible. As a ghost it carried no background and
 * no border at rest, so it read as grey body text next to the label and there
 * was nothing on screen saying the snippet could be copied. It wears the
 * outlined variant now: still small, still quiet, but an affordance at rest.
 */
import { Route, Router } from "@solidjs/router"
import { render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import McpSettings from "~/modules/settings/McpSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

const BASE = "https://example.test"

function renderPage() {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <McpSettings />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("McpSettings copy controls", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        const json = (body: unknown) =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        if (url.endsWith("/api/mcp/connect-info")) return json({ data: { baseUrl: BASE } })
        if (url.endsWith("/api/mcp/connections")) return json({ data: [] })
        return Promise.reject(new Error(`Unhandled fetch: ${url}`))
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("renders each copy control as the design system's small action, not a full width block", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("mcp-cli-snippet-copy")).toBeInTheDocument())
    for (const testid of ["mcp-cli-snippet-copy", "mcp-desktop-snippet-copy"]) {
      const control = screen.getByTestId(testid)
      const cls = control.getAttribute("class") ?? ""
      // Quiet: no filled accent background, and the small size's own padding,
      // never the default size's full width row.
      expect(cls).not.toContain("w-full")
      expect(cls).not.toContain("bg-accent")
      expect(cls).toContain("px-2.5")
      expect(cls).toContain("text-xs")
      // It sits next to its label on the same row, not above or below it.
      const row = control.parentElement
      expect(row?.getAttribute("class") ?? "").toContain("items-center")
    }
  })

  // The bug: at rest the control was a bare word in body-text grey, so nothing
  // told the reader it was a button until they happened to hover it.
  it("draws a border at rest, so the control is visibly a button before it is hovered", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("mcp-cli-snippet-copy")).toBeInTheDocument())
    for (const testid of ["mcp-cli-snippet-copy", "mcp-desktop-snippet-copy"]) {
      const classes = (screen.getByTestId(testid).getAttribute("class") ?? "").split(/\s+/)
      expect(classes).toContain("border")
      expect(classes).toContain("border-border")
      // Every other visual cue on this control is a hover state, and a hover
      // state is not an affordance at rest.
      expect(classes.filter((c) => c.startsWith("hover:")).length).toBeGreaterThan(0)
    }
  })
})
