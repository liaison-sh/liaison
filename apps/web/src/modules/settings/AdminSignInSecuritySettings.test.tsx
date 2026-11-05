// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AdminSignInSecuritySettings from "~/modules/settings/AdminSignInSecuritySettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

let stored: boolean | undefined
let patchStatus = 200
let patchBodies: unknown[] = []

function setupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const method = init?.method ?? "GET"
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      if (url.endsWith("/org") && method === "GET") {
        const settings = stored === undefined ? {} : { requireAdminSecondFactor: stored }
        return json({ data: { id: "o1", name: "Org", settings } })
      }
      if (url.endsWith("/org") && method === "PATCH") {
        const body = JSON.parse(String(init?.body))
        patchBodies.push(body)
        if (patchStatus !== 200) return json({ error: { message: "needs own" } }, patchStatus)
        stored = body.settings.requireAdminSecondFactor
        return json({ data: { settings: body.settings } })
      }
      return json({})
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
            <AdminSignInSecuritySettings />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

const SWITCH = "sign-in-security-require-admin-switch"
const isOn = () => screen.getByTestId(SWITCH).getAttribute("aria-checked") === "true"

describe("AdminSignInSecuritySettings", () => {
  beforeEach(() => {
    stored = undefined
    patchStatus = 200
    patchBodies = []
    setupFetch()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("is off by default and switching it on writes requireAdminSecondFactor", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId(SWITCH)).toBeInTheDocument())
    expect(isOn()).toBe(false)
    fireEvent.click(screen.getByTestId(SWITCH))
    await waitFor(() => expect(patchBodies).toHaveLength(1))
    expect(patchBodies[0]).toEqual({ settings: { requireAdminSecondFactor: true } })
    expect(isOn()).toBe(true)
  })

  it("goes back off when the server refuses (the admin has no second factor yet)", async () => {
    patchStatus = 409
    renderPage()
    await waitFor(() => expect(screen.getByTestId(SWITCH)).toBeInTheDocument())
    fireEvent.click(screen.getByTestId(SWITCH))
    await waitFor(() => expect(patchBodies).toHaveLength(1))
    await waitFor(() => expect(isOn()).toBe(false))
  })
})
