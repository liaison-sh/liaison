// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AdminMediaAnalysisSettings from "~/modules/settings/AdminMediaAnalysisSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

const DEFAULTS = {
  tickets: { image: true, video: true },
  mail: { image: false, video: false },
}

let putBodies: unknown[] = []
let putShouldFail = false

function setupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const method = init?.method ?? "GET"
      if (url.includes("/org/settings/media-analysis") && method === "GET") {
        return new Response(JSON.stringify({ data: DEFAULTS }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.includes("/org/settings/media-analysis") && method === "PUT") {
        putBodies.push(JSON.parse(String(init?.body)))
        if (putShouldFail) {
          return new Response(JSON.stringify({ error: { message: "boom" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ data: JSON.parse(String(init?.body)) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    }),
  )
}

function renderPage() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <AdminMediaAnalysisSettings />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

function isPressed(testid: string): boolean {
  return screen.getByTestId(testid).getAttribute("data-pressed") !== null
}

describe("AdminMediaAnalysisSettings", () => {
  beforeEach(() => {
    putBodies = []
    putShouldFail = false
    setupFetch()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("renders four toggles reflecting tickets-on / email-off defaults", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("media-analysis-grid")).toBeInTheDocument())
    expect(isPressed("media-analysis-toggle-tickets-image")).toBe(true)
    expect(isPressed("media-analysis-toggle-tickets-video")).toBe(true)
    expect(isPressed("media-analysis-toggle-mail-image")).toBe(false)
    expect(isPressed("media-analysis-toggle-mail-video")).toBe(false)
  })

  it("toggling Tickets→Videos off PUTs the full four-boolean body", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId("media-analysis-grid")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("media-analysis-toggle-tickets-video"))
    await waitFor(() => expect(putBodies.length).toBe(1))
    expect(putBodies[0]).toEqual({
      tickets: { image: true, video: false },
      mail: { image: false, video: false },
    })
    // Optimistic update applied.
    expect(isPressed("media-analysis-toggle-tickets-video")).toBe(false)
  })

  it("reverts the toggle when the PUT fails", async () => {
    putShouldFail = true
    renderPage()
    await waitFor(() => expect(screen.getByTestId("media-analysis-grid")).toBeInTheDocument())
    expect(isPressed("media-analysis-toggle-mail-image")).toBe(false)
    fireEvent.click(screen.getByTestId("media-analysis-toggle-mail-image"))
    // After the failed PUT resolves, the toggle reverts to its prior (off) state.
    await waitFor(() => expect(putBodies.length).toBe(1))
    await waitFor(() => expect(isPressed("media-analysis-toggle-mail-image")).toBe(false))
  })
})
