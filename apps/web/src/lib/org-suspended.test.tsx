// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A managed workspace suspended or closed for billing under an open tab (S26):
// the first 403 `org_suspended` from REST, a token refresh or the websocket
// ticket puts the page on the suspended view, once, with no toast and no login
// page. The view shows the billing contact from the body; an admin inside the
// window gets the export and Billing, a member does not.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApiClient } from "~/lib/api-client"
import {
  _resetOrgSuspended,
  noteOrgSuspended,
  orgSuspended,
  orgSuspension,
} from "~/lib/org-suspended"
import { accessToken, clearAuth, restoreSession, setTokens } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import OrgSuspendedPage from "~/modules/shell/OrgSuspendedPage"
import { OrgSuspendedRoot } from "~/modules/shell/OrgSuspendedRoot"

const UNTIL = new Date(Date.now() + 20 * 86_400_000).toISOString()
const CONTACT = "billing@contact.example"

function jwt(scopes: string[]): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Person",
      roles: [],
      scopes,
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function suspended(accessUntil: string | null = UNTIL): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "org_suspended",
        accessUntil,
        contact: CONTACT,
        message: "This workspace is suspended.",
      },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  )
}

beforeEach(() => {
  _resetOrgSuspended()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  clearAuth()
  _resetOrgSuspended()
})

describe("the suspension is learnt once, from every credential path", () => {
  it("REST: no toast, no login page, the details kept", async () => {
    setTokens(jwt([]))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => suspended()),
    )
    const onError = vi.fn()
    const onUnauthorized = vi.fn()
    const api = createApiClient({ getAccessToken: accessToken, onUnauthorized, onError })
    await expect(api.get("/threads")).rejects.toMatchObject({ status: 403, code: "org_suspended" })
    await api.get("/attention").catch(() => undefined)
    expect(orgSuspended()).toBe(true)
    expect(orgSuspension()).toEqual({ accessUntil: UNTIL, contact: CONTACT })
    expect(onError).not.toHaveBeenCalled()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("a refused token refresh (a member's session) lands on the suspended page, not the login page", async () => {
    setTokens(jwt([]))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => suspended()),
    )
    await authManager.ensureFreshToken({ force: true }).catch(() => undefined)
    expect(orgSuspension()).toEqual({ accessUntil: UNTIL, contact: CONTACT })
  })

  it("a refused session restore on load lands on the suspended page", async () => {
    setTokens(jwt([]))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => suspended(null)),
    )
    await restoreSession()
    expect(orgSuspension()).toEqual({ accessUntil: null, contact: CONTACT })
  })

  it("an ordinary 403 is left alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "Forbidden", code: "FORBIDDEN" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    )
    const onError = vi.fn()
    const api = createApiClient({ getAccessToken: accessToken, onUnauthorized: vi.fn(), onError })
    await api.get("/threads").catch(() => undefined)
    expect(orgSuspended()).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it("the first report wins; later ones change nothing", () => {
    noteOrgSuspended({ accessUntil: UNTIL, contact: CONTACT })
    noteOrgSuspended({ accessUntil: null, contact: null })
    expect(orgSuspension()).toEqual({ accessUntil: UNTIL, contact: CONTACT })
  })
})

describe("the suspended page", () => {
  function renderPage() {
    render(() => (
      <I18nProvider initialLocale="en">
        <Router>
          <Route path="*" component={() => <OrgSuspendedPage leave={vi.fn()} />} />
        </Router>
      </I18nProvider>
    ))
  }

  it("shows one sentence and the contact from the body", () => {
    setTokens(jwt([]))
    noteOrgSuspended({ accessUntil: UNTIL, contact: CONTACT })
    renderPage()
    expect(screen.getByTestId("org-suspended-sentence")).toHaveTextContent(
      "This workspace is suspended",
    )
    expect(screen.getByTestId("org-suspended-contact")).toHaveTextContent(CONTACT)
  })

  it("a member gets no export or Billing", () => {
    setTokens(jwt(["kernel:threads"]))
    noteOrgSuspended({ accessUntil: UNTIL, contact: CONTACT })
    renderPage()
    expect(screen.queryByTestId("org-suspended-export")).toBeNull()
    expect(screen.queryByTestId("org-suspended-billing")).toBeNull()
  })

  it("an admin inside the window gets the export and Billing, opened inside the page", async () => {
    setTokens(jwt(["kernel:org:admin"]))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    )
    noteOrgSuspended({ accessUntil: UNTIL, contact: CONTACT })
    renderPage()
    expect(screen.getByTestId("org-suspended-until")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("org-suspended-export"))
    expect(
      await screen.findByTestId("org-suspended-export-section", {}, { timeout: 8000 }),
    ).toBeInTheDocument()
  }, 15_000)

  it("an admin of a closed workspace (no access left) gets no export", () => {
    setTokens(jwt(["kernel:org:admin"]))
    noteOrgSuspended({ accessUntil: null, contact: CONTACT })
    renderPage()
    expect(screen.queryByTestId("org-suspended-export")).toBeNull()
    expect(screen.getByTestId("org-suspended-contact")).toHaveTextContent(CONTACT)
  })

  it("every route becomes the suspended page once the org is suspended", async () => {
    render(() => (
      <I18nProvider initialLocale="en">
        <Router root={OrgSuspendedRoot}>
          <Route path="*" component={() => <p data-testid="some-route">route</p>} />
        </Router>
      </I18nProvider>
    ))
    expect(screen.getByTestId("some-route")).toBeInTheDocument()
    noteOrgSuspended({ accessUntil: null, contact: CONTACT })
    expect(await screen.findByTestId("org-suspended")).toBeInTheDocument()
    expect(screen.queryByTestId("some-route")).toBeNull()
  })
})
