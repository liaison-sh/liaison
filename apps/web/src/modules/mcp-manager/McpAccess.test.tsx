// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who can use an organization MCP server, in the UI: the server page's
// "Who can use it" section saves through PUT /connections/:id/access with the
// same picker as an app's access; the tools review offers the same choice as a
// compact row with Everyone preselected; "Fine-tune in Roles & access" opens
// the roles page filtered to the server's permission, which names the server
// and shows only the roles that hold a grant for it.
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { ConnectionDetail } from "~/modules/mcp-manager/ConnectionDetail"
import { McpToolsReviewDialog } from "~/modules/mcp-manager/McpToolsReviewDialog"
import { renderInApp } from "~/modules/mcp-manager/test-render"
import AdminRoles from "~/modules/settings/AdminRoles"
import { resetWorkspaceRoles } from "~/modules/settings/app-management/workspace-roles"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"

const ID = "conn-1"
const SUPPORT = "00000000-0000-4000-8000-0000000000r1"
const SALES = "00000000-0000-4000-8000-0000000000r2"

const CONN = {
  id: ID,
  slug: "crm",
  displayName: "Acme CRM",
  transport: "http",
  ownershipScope: "org",
  managedBy: "ui",
  agentVisibility: "discoverable",
  exposeViaGateway: true,
  connectionDefaultPolicy: "gate_writes",
  rateCapPerMinute: null,
  disabled: false,
  httpUrl: "https://mcp.crm.example",
  authFlavor: "none",
  customHeaderNames: [],
  toolsReviewedAt: "2026-10-24T00:00:00Z",
  accessMode: "everyone",
  createdAt: "2026-10-24T00:00:00Z",
  updatedAt: "2026-10-24T00:00:00Z",
}

function jwt(scopes: string[]): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "00000000-0000-4000-8000-00000000a001",
      orgId: "o1",
      name: "Admin",
      roles: ["admin"],
      scopes,
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

type Call = { method: string; url: string; body: unknown }

function serve(): Call[] {
  const calls: Call[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    const raw = init?.body
    calls.push({ method, url, body: typeof raw === "string" ? JSON.parse(raw) : undefined })
    const json = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    if (url.includes(`/connections/${ID}/access`)) {
      if (method === "PUT") return json(JSON.parse(String(raw)))
      return json({ mode: "everyone", roleIds: [], userIds: [] })
    }
    if (url.includes("/admin/roles/")) {
      const roleId = url.split("/admin/roles/")[1]
      return json({
        id: roleId,
        name: roleId === SUPPORT ? "Support" : "Sales",
        scopes: roleId === SUPPORT ? [{ scope: "mcp:crm:search_objects" }] : [{ scope: "tickets" }],
        dimensionGrants: [],
        members: [],
      })
    }
    if (url.includes("/admin/roles")) {
      return json([
        { id: SUPPORT, name: "Support", memberCount: 2, scopeCount: 1 },
        { id: SALES, name: "Sales", memberCount: 1, scopeCount: 1 },
      ])
    }
    if (url.includes("/admin/users")) return json([])
    if (url.includes("/policy")) return json([])
    if (url.includes("/tools")) return json([{ name: "search_objects", description: "Reads" }])
    if (url.includes("/audit")) return json([])
    if (method === "PATCH") return json(CONN)
    if (url.endsWith(`/connections/${ID}`)) return json(CONN)
    if (url.endsWith("/apps/mcp-manager/connections")) {
      return json([{ ...CONN, status: "connected", toolCount: 1, lastError: null }])
    }
    return json(null)
  })
  return calls
}

const ADMIN_SCOPES = [
  "mcp_manager:connection:read",
  "mcp_manager:connection:admin",
  "mcp_manager:policy:write",
  "kernel:users:admin",
]

beforeEach(() => {
  resetWorkspaceRoles()
  BillingStateTestAccess.setMode("self_hosted")
})

afterEach(() => {
  cleanup()
  clearAuth()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  BillingStateTestAccess.reset()
  window.history.replaceState(null, "", "/")
})

describe("Who can use it, on an org server's page", () => {
  it("restricting to a role saves through PUT /access", async () => {
    setTokens(jwt(ADMIN_SCOPES))
    const calls = serve()
    renderInApp(() => <ConnectionDetail connectionId={ID} />)
    const section = await screen.findByTestId("mcp-detail-section-access")
    expect(section).toHaveTextContent("Who can use it")
    const everyone = (await within(section).findByTestId("mcp-access-everyone")) as HTMLInputElement
    expect(everyone.checked).toBe(true)
    // Nothing to save until something changes.
    expect(within(section).getByTestId("mcp-access-save")).toBeDisabled()

    fireEvent.click(within(section).getByTestId("mcp-access-some"))
    fireEvent.click(await within(section).findByTestId(`mcp-access-role-${SUPPORT}`))
    fireEvent.click(within(section).getByTestId("mcp-access-save"))

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.url.includes("/access"))?.body).toEqual({
        mode: "restricted",
        roleIds: [SUPPORT],
        userIds: [],
      }),
    )
    await waitFor(() => expect(within(section).getByTestId("mcp-access-save")).toBeDisabled())
  })

  it("links to Roles & access filtered to the server's permission", async () => {
    setTokens(jwt(ADMIN_SCOPES))
    serve()
    renderInApp(() => <ConnectionDetail connectionId={ID} />)
    const link = await screen.findByTestId("mcp-access-fine-tune")
    expect(link).toHaveTextContent("Fine-tune in Roles & access")
    expect(link.getAttribute("href")).toBe("/settings/admin/roles?scope=mcp%3Acrm")
  })

  it("is not offered to someone who may not decide it", async () => {
    setTokens(jwt(["mcp_manager:connection:read"]))
    serve()
    renderInApp(() => <ConnectionDetail connectionId={ID} />)
    expect(await screen.findByTestId("mcp-detail-header")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-detail-section-access")).toBeNull()
  })
})

describe("Who can use it, in the tools review", () => {
  it("shows a compact row with Everyone preselected, saved on Done", async () => {
    setTokens(jwt(ADMIN_SCOPES))
    const calls = serve()
    const onClose = vi.fn()
    renderInApp(() => (
      <McpToolsReviewDialog
        open={true}
        connectionId={ID}
        serverName="Acme CRM"
        currentPolicy="gate_writes"
        tools={[{ name: "search_objects", description: "Reads", readOnly: true }]}
        accessSlug="crm"
        onClose={onClose}
      />
    ))
    const row = await screen.findByTestId("mcp-review-access")
    expect(row).toHaveTextContent("Who can use it")
    expect(
      (within(row).getByTestId("mcp-review-access-everyone") as HTMLInputElement).checked,
    ).toBe(true)
    expect(within(row).getByTestId("mcp-review-access-fine-tune").getAttribute("href")).toBe(
      "/settings/admin/roles?scope=mcp%3Acrm",
    )
    fireEvent.click(screen.getByTestId("mcp-tools-review-done"))
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
    expect(calls.find((c) => c.method === "PUT" && c.url.includes("/access"))?.body).toEqual({
      mode: "everyone",
      roleIds: [],
      userIds: [],
    })
  })

  it("has no access row for a personal server", async () => {
    setTokens(jwt(ADMIN_SCOPES))
    serve()
    renderInApp(() => (
      <McpToolsReviewDialog
        open={true}
        connectionId={ID}
        serverName="Acme CRM"
        currentPolicy="gate_writes"
        tools={[]}
        onClose={() => {}}
      />
    ))
    expect(await screen.findByTestId("mcp-tools-review")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-review-access")).toBeNull()
  })
})

describe("Roles & access filtered to a server", () => {
  it("names the server and lists only the roles holding a grant for it", async () => {
    setTokens(jwt(ADMIN_SCOPES))
    serve()
    window.history.replaceState(null, "", "/settings/admin/roles?scope=mcp%3Acrm")
    renderInApp(() => <AdminRoles />)
    const banner = await screen.findByTestId("admin-roles-scope-filter")
    await waitFor(() => expect(banner).toHaveTextContent("Roles with a permission for Acme CRM"))
    expect(banner).not.toHaveTextContent("mcp:crm")
    expect(screen.getByTestId("admin-roles-scope-filter-server").getAttribute("href")).toBe(
      `/settings/connectors/mcp/${ID}`,
    )
    expect(await screen.findByTestId(`admin-roles-row-${SUPPORT}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`admin-roles-row-${SALES}`)).toBeNull()
  })
})
