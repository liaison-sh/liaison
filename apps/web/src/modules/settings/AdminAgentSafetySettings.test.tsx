// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AdminAgentSafetySettings from "~/modules/settings/AdminAgentSafetySettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

let stored: string | undefined
let patchBodies: unknown[] = []

function setupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const method = init?.method ?? "GET"
      if (url.endsWith("/org") && method === "GET") {
        const settings = stored === undefined ? {} : { webContentProtection: stored }
        return new Response(JSON.stringify({ data: { id: "o1", name: "Org", settings } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.endsWith("/org") && method === "PATCH") {
        const body = JSON.parse(String(init?.body))
        patchBodies.push(body)
        stored = body.settings.webContentProtection
        return new Response(JSON.stringify({ data: { settings: body.settings } }), {
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
            <AdminAgentSafetySettings />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

const SWITCH = "agent-safety-untrusted-switch"
const isOn = () => screen.getByTestId(SWITCH).getAttribute("aria-checked") === "true"

describe("AdminAgentSafetySettings", () => {
  beforeEach(() => {
    stored = undefined
    patchBodies = []
    setupFetch()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("is on by default and switching it off writes 'off' with a warning", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId(SWITCH)).toBeInTheDocument())
    expect(isOn()).toBe(true)
    expect(screen.queryByTestId("agent-safety-off-note")).toBeNull()

    fireEvent.click(screen.getByTestId(SWITCH))
    await waitFor(() => expect(patchBodies).toHaveLength(1))
    expect(patchBodies[0]).toEqual({ settings: { webContentProtection: "off" } })
    expect(isOn()).toBe(false)
    expect(screen.getByTestId("agent-safety-off-note")).toBeInTheDocument()
  })

  it("switching back on restores the org's stricter 'hardened' posture", async () => {
    stored = "hardened"
    renderPage()
    await waitFor(() => expect(screen.getByTestId(SWITCH)).toBeInTheDocument())
    expect(isOn()).toBe(true)
    fireEvent.click(screen.getByTestId(SWITCH))
    await waitFor(() => expect(patchBodies).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId(SWITCH)).not.toBeDisabled())
    fireEvent.click(screen.getByTestId(SWITCH))
    await waitFor(() => expect(patchBodies).toHaveLength(2))
    expect(patchBodies[1]).toEqual({ settings: { webContentProtection: "hardened" } })
  })
})
