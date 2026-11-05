// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AdminRoleDetail from "~/modules/settings/AdminRoleDetail"
import AdminRoles from "~/modules/settings/AdminRoles"
import { ApiProvider } from "~/modules/shell/ApiContext"

const ROLE = "33333333-3333-4333-8333-333333333333"

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function mockListFetch(rows: any[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/admin/roles") && !url.match(/\/roles\/[^/]+/)) {
        return jsonResp({ data: rows })
      }
      return jsonResp({})
    }),
  )
}

function renderList() {
  window.history.pushState({}, "", "/settings/admin/roles")
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <AdminRoles />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

function mockDetailFetch(opts: {
  detail?: any
  catalog?: Array<{ scope: string; app: string; description?: string }>
  addStatus?: number
  removeStatus?: number
  deleteStatus?: number
}) {
  const detail = opts.detail ?? {
    id: ROLE,
    name: "Support",
    description: null,
    scopes: [{ scope: "tickets:tickets:read" }],
    dimensionGrants: [],
    members: [],
  }
  const catalog = opts.catalog ?? [
    { scope: "tickets:tickets:read", app: "tickets" },
    { scope: "tickets:tickets:write", app: "tickets", description: "Write tickets" },
  ]
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (url.match(/\/admin\/roles\/[^/]+\/scopes\/.+/) && method === "DELETE") {
      return jsonResp({}, opts.removeStatus ?? 200)
    }
    if (url.match(/\/admin\/roles\/[^/]+\/scopes$/) && method === "POST") {
      return jsonResp({}, opts.addStatus ?? 201)
    }
    if (url.match(/\/admin\/roles\/[^/]+$/) && method === "DELETE") {
      return jsonResp({}, opts.deleteStatus ?? 200)
    }
    if (url.includes("/admin/scope-catalog")) {
      return jsonResp({ data: catalog })
    }
    if (url.match(/\/admin\/roles\/[^/]+$/) && method === "GET") {
      return jsonResp({ data: detail })
    }
    return jsonResp({})
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function renderDetail() {
  window.history.pushState({}, "", `/settings/admin/roles/${ROLE}`)
  return render(() => (
    <Router>
      <Route
        path="/settings/admin/roles/:id"
        component={() => (
          <ApiProvider>
            <AdminRoleDetail />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

beforeEach(() => {})
afterEach(() => vi.unstubAllGlobals())

describe("AdminRoles list", () => {
  it("renders rows with member and scope counts", async () => {
    mockListFetch([
      { id: ROLE, name: "Support", description: "Support team", memberCount: 3, scopeCount: 5 },
    ])
    renderList()
    expect(await screen.findByText("Support")).toBeInTheDocument()
    expect(screen.getByTestId(`admin-roles-row-${ROLE}`)).toHaveTextContent("3")
    expect(screen.getByTestId(`admin-roles-row-${ROLE}`)).toHaveTextContent("5")
  })

  it("names an app's own role by the app and its tier, not the raw id", async () => {
    mockListFetch([{ id: ROLE, name: "api-connector.admin", memberCount: 0, scopeCount: 4 }])
    renderList()
    const row = await screen.findByTestId(`admin-roles-row-${ROLE}`)
    expect(row).toHaveTextContent("API connector · Admin")
    expect(row).not.toHaveTextContent("api-connector.admin")
  })
})

describe("AdminRoleDetail", () => {
  it("renders scopes and members sections (role = capabilities only)", async () => {
    mockDetailFetch({})
    renderDetail()
    expect(await screen.findByTestId("admin-role-section-scopes")).toBeInTheDocument()
    expect(screen.getByTestId("admin-role-section-members")).toBeInTheDocument()
    // Roles intentionally have no dimension editor — dimensions are a per-user attribute.
    expect(screen.queryByTestId("admin-role-section-dimensions")).not.toBeInTheDocument()
  })

  it("typeahead lists catalog entries when searching", async () => {
    mockDetailFetch({})
    renderDetail()
    const input = (await screen.findByTestId("admin-role-scope-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "tickets" } })
    await waitFor(() => {
      expect(screen.getByTestId("admin-role-add-scope-tickets:tickets:write")).toBeInTheDocument()
    })
  })

  it("add scope POSTs to /admin/roles/:id/scopes", async () => {
    const fetchMock = mockDetailFetch({})
    renderDetail()
    fireEvent.input(await screen.findByTestId("admin-role-scope-input"), {
      target: { value: "tickets" },
    })
    const addBtn = await screen.findByTestId("admin-role-add-scope-tickets:tickets:write")
    fireEvent.click(addBtn)
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => ({
        url: c[0] as string,
        method: (c[1] as RequestInit | undefined)?.method,
      }))
      expect(
        calls.some((c) => c.method === "POST" && c.url.includes(`/admin/roles/${ROLE}/scopes`)),
      ).toBe(true)
    })
  })

  it("delete with active members shows modal copy and disables confirm", async () => {
    mockDetailFetch({
      detail: {
        id: ROLE,
        name: "Support",
        description: null,
        scopes: [],
        dimensionGrants: [],
        members: [{ id: "u1", name: "Alice", email: "a@x.com" }],
      },
    })
    renderDetail()
    fireEvent.click(await screen.findByTestId("admin-role-delete-button"))
    expect(await screen.findByTestId("admin-role-delete-modal")).toHaveTextContent(
      /cannot delete a role with active members/i,
    )
    expect(screen.getByTestId("admin-role-confirm-delete")).toBeDisabled()
  })
})
