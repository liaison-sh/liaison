// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AdminUserDetail from "~/modules/settings/AdminUserDetail"
import { ApiProvider } from "~/modules/shell/ApiContext"

const USER = "11111111-1111-4111-8111-111111111111"
const ROLE = "33333333-3333-4333-8333-333333333333"
const ADMIN_ROLE = "44444444-4444-4444-8444-444444444444"

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function userDetailFixture(overrides: { roles?: string[] } = {}) {
  const roles = (overrides.roles ?? []).map((id) => ({ id, name: id === ROLE ? "Support" : id }))
  return {
    id: USER,
    email: "alice@test.com",
    name: "Alice",
    status: "active" as const,
    roles,
    effectiveScopes: [{ scope: "tickets:tickets:read", fromRoles: [], direct: true }],
    dimensions: {
      team: { direct: ["t1"], inherited: [] },
    },
  }
}

interface MockOpts {
  detail?: any
  roles?: any[]
  dimensionCatalog?: Array<{
    key: string
    app: string
    type: string
    order?: string[]
    values?: string[]
    label?: string
    description?: string
    manageHref?: string
  }>
  scopeCatalog?: Array<{ scope: string; app: string; description?: string }>
  assignStatus?: number
  unassignStatus?: number
  patchStatus?: number
}

function mockFetch(opts: MockOpts = {}): ReturnType<typeof vi.fn> {
  const detail = opts.detail ?? userDetailFixture()
  const roles = opts.roles ?? [
    { id: ROLE, name: "Support" },
    { id: ADMIN_ROLE, name: "Admin" },
  ]
  const dimensionCatalog = opts.dimensionCatalog ?? [
    {
      key: "tickets:team",
      app: "tickets",
      type: "membership",
      label: "Team",
      values: ["support-us", "support-east"],
    },
  ]
  const scopeCatalog = opts.scopeCatalog ?? [{ scope: "tickets:tickets:read", app: "tickets" }]
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (url.match(/\/admin\/roles\/[^/]+\/users\/[^/]+/) && method === "DELETE") {
      return jsonResp({ data: { deleted: true } }, opts.unassignStatus ?? 200)
    }
    if (url.match(/\/admin\/roles\/users\/[^/]+\/dimensions\/[^/]+/) && method === "DELETE") {
      return jsonResp({ data: { deleted: true } })
    }
    if (url.match(/\/admin\/roles\/users\/[^/]+\/dimensions$/) && method === "POST") {
      return jsonResp({ data: { id: "dimension" } }, 201)
    }
    if (url.match(/\/admin\/roles\/[^/]+\/users/) && method === "POST") {
      const status = opts.assignStatus ?? 201
      const body =
        status === 403
          ? { error: { code: "SCOPE_ESCALATION", message: "Forbidden" } }
          : { data: { id: "ok" } }
      return jsonResp(body, status)
    }
    if (url.match(/\/admin\/users\/[^/]+$/) && method === "PATCH") {
      return jsonResp({ data: { ok: true } }, opts.patchStatus ?? 200)
    }
    if (url.match(/\/admin\/users\/[^/]+$/) && method === "GET") {
      return jsonResp({ data: detail })
    }
    if (url.includes("/admin/dimension-catalog")) {
      return jsonResp({ data: dimensionCatalog })
    }
    if (url.includes("/admin/scope-catalog")) {
      return jsonResp({ data: scopeCatalog })
    }
    if (url.includes("/admin/roles") && method === "GET") {
      return jsonResp({ data: roles })
    }
    return jsonResp({})
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function renderDetail() {
  window.history.pushState({}, "", `/settings/admin/users/${USER}`)
  return render(() => (
    <Router>
      <Route
        path="/settings/admin/users/:id"
        component={() => (
          <ApiProvider>
            <AdminUserDetail />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

beforeEach(() => {})
afterEach(() => vi.unstubAllGlobals())

describe("AdminUserDetail", () => {
  it("renders identity, roles, effective scopes, and dimensions sections", async () => {
    mockFetch({ detail: userDetailFixture({ roles: [ROLE] }) })
    renderDetail()
    expect(await screen.findByTestId("admin-user-section-identity")).toBeInTheDocument()
    expect(screen.getByTestId("admin-user-section-roles")).toBeInTheDocument()
    expect(screen.getByTestId("admin-user-section-effective-scopes")).toBeInTheDocument()
    expect(screen.getByTestId("admin-user-section-dimensions")).toBeInTheDocument()
  })

  it("clicking an unassigned role card posts to /admin/roles/:roleId/users", async () => {
    const fetchMock = mockFetch()
    renderDetail()
    const card = await screen.findByTestId(`admin-user-role-card-${ROLE}`)
    fireEvent.click(card)
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => ({
        url: c[0] as string,
        method: (c[1] as RequestInit | undefined)?.method,
      }))
      expect(
        calls.some((c) => c.method === "POST" && c.url.includes(`/admin/roles/${ROLE}/users`)),
      ).toBe(true)
    })
  })

  it("unassign deletes /admin/roles/:roleId/users/:userId", async () => {
    const fetchMock = mockFetch({ detail: userDetailFixture({ roles: [ROLE] }) })
    renderDetail()
    const unassignBtn = await screen.findByTestId(`admin-user-unassign-${ROLE}`)
    fireEvent.click(unassignBtn)
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => ({
        url: c[0] as string,
        method: (c[1] as RequestInit | undefined)?.method,
      }))
      expect(
        calls.some(
          (c) => c.method === "DELETE" && c.url.includes(`/admin/roles/${ROLE}/users/${USER}`),
        ),
      ).toBe(true)
    })
  })

  it("scope-escalation 403 surfaces calm inline error", async () => {
    mockFetch({ assignStatus: 403 })
    renderDetail()
    const card = await screen.findByTestId(`admin-user-role-card-${ADMIN_ROLE}`)
    fireEvent.click(card)
    expect(await screen.findByTestId("admin-user-assign-error")).toHaveTextContent(
      /can't assign a role/i,
    )
  })

  it("identity edits show ContextualSaveBar", async () => {
    mockFetch()
    renderDetail()
    const nameInput = (await screen.findByTestId("admin-user-name-input")) as HTMLInputElement
    expect(screen.queryByTestId("save-bar")).toBeNull()
    fireEvent.input(nameInput, { target: { value: "Alice Updated" } })
    expect(await screen.findByTestId("save-bar")).toBeInTheDocument()
  })

  it("ticking a declared dimension value POSTs the new set of values", async () => {
    const fetchMock = mockFetch({
      detail: { ...userDetailFixture(), dimensions: {} },
    })
    renderDetail()
    // tickets:team declares support-us / support-east as catalog values.
    const chip = await screen.findByTestId("admin-user-dimension-value-tickets:team-support-us")
    fireEvent.click(chip)

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => ({
        url: c[0] as string,
        method: (c[1] as RequestInit | undefined)?.method,
        body: (c[1] as RequestInit | undefined)?.body
          ? JSON.parse(String((c[1] as RequestInit).body))
          : undefined,
      }))
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "POST",
          url: `/api/admin/roles/users/${USER}/dimensions`,
          body: { dimension: "tickets:team", values: ["support-us"] },
        }),
      )
    })
  })

  it("unticking the last value DELETEs the dimension grant", async () => {
    const fetchMock = mockFetch({
      detail: {
        ...userDetailFixture(),
        dimensions: { "tickets:team": { direct: ["support-us"], inherited: [] } },
      },
    })
    renderDetail()
    fireEvent.click(await screen.findByTestId("admin-user-dimension-value-tickets:team-support-us"))
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => ({
        url: c[0] as string,
        method: (c[1] as RequestInit | undefined)?.method,
      }))
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "DELETE",
          url: `/api/admin/roles/users/${USER}/dimensions/tickets%3Ateam`,
        }),
      )
    })
  })

  it("dimensions without values or manageHref are hidden from the admin UI", async () => {
    mockFetch({
      detail: { ...userDetailFixture(), dimensions: {} },
      dimensionCatalog: [
        // Properly catalogued — should render checkboxes.
        {
          key: "tickets:team",
          app: "tickets",
          type: "membership",
          label: "Team",
          values: ["support-us"],
        },
        // Dynamic — should render a "Manage in …" link.
        {
          key: "mail:inbox",
          app: "mail",
          type: "membership",
          label: "Inbox",
          manageHref: "/settings/mail/accounts",
        },
        // Mis-configured — neither values nor manageHref → must be hidden.
        { key: "other:something", app: "other", type: "membership" },
      ],
    })
    renderDetail()
    await screen.findByTestId("admin-user-dimension-value-tickets:team-support-us")
    expect(screen.getByTestId("admin-user-dimension-manage-mail:inbox")).toHaveAttribute(
      "href",
      "/settings/mail/accounts",
    )
    expect(screen.queryByTestId("admin-user-dimension-other:something")).not.toBeInTheDocument()
  })
})
