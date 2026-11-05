// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T1b: members reach their OWN MCP connections from Settings -> Connections
// (the page that merged "MCP" and "My connections"). The org page (Settings ->
// MCP servers) stays behind kernel:org:admin; the personal block is gated by
// mcp_manager:personal_connection:write (every member holds it), lists only
// the caller's personal connections and adds through the stepped add flow
// forced to personal, with no ownership choice.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { MyMcpConnectionsPage } from "~/modules/mcp-manager/MyMcpConnectionsPage"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"
import { SettingsSidebar } from "~/modules/settings/SettingsSidebar"
import { ApiProvider } from "~/modules/shell/ApiContext"

const ME = "00000000-0000-4000-8000-00000000a001"
const SOMEONE_ELSE = "00000000-0000-4000-8000-00000000a002"

function jwt(scopes: string[], userId = ME): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId,
      orgId: "o1",
      name: "Member",
      roles: ["member"],
      scopes,
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

const MEMBER_SCOPES = ["mcp_manager:connection:read", "mcp_manager:personal_connection:write"]

type Call = { method: string; url: string; body: unknown }

/** A fetch stub that records every call (method, path, JSON body). */
function recordingApi(routes: Array<[method: string, needle: string, data: unknown]>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    const raw = init?.body
    calls.push({ method, url, body: typeof raw === "string" ? JSON.parse(raw) : undefined })
    for (const [m, needle, data] of routes) {
      if (m === method && url.includes(needle)) {
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
    }
    return new Response(JSON.stringify({ error: { message: "mock miss", code: "mock_miss" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  })
  return calls
}

function inApp(child: () => unknown) {
  return render(() => (
    <Router>
      <Route path="*" component={() => <ApiProvider>{child() as never}</ApiProvider>} />
    </Router>
  ))
}

function row(over: Record<string, unknown>) {
  return {
    id: "c-x",
    slug: "x",
    displayName: "X",
    transport: "http",
    ownershipScope: "personal",
    ownerUserId: ME,
    managedBy: "ui",
    agentVisibility: "discoverable",
    exposeViaGateway: false,
    connectionDefaultPolicy: "gate_writes",
    rateCapPerMinute: null,
    disabled: false,
    status: "connected",
    toolCount: 2,
    lastCallAgo: null,
    lastCheckedAt: null,
    lastError: null,
    ...over,
  }
}

describe("Settings -> Connected tools (who sees it)", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    BillingStateTestAccess.reset()
    bootstrapKernelApps()
  })
  afterEach(() => {
    cleanup()
    clearAuth()
    vi.unstubAllGlobals()
  })

  it("a member sees Connected tools, and not the organisation's MCP servers", () => {
    setTokens(jwt(MEMBER_SCOPES), "refresh")
    inApp(() => <SettingsSidebar />)
    const link = screen.getByTestId("settings-link-kernel:connected-tools")
    expect(link.getAttribute("href")).toBe("/settings/connected-tools")
    // Org MCP servers live on the Connectors page, which a member does not get.
    expect(screen.queryByTestId("settings-link-kernel:connectors")).toBeNull()
    // The two former pages are one row now.
    expect(screen.queryByTestId("settings-link-kernel:my-mcp-connections")).toBeNull()
    expect(screen.queryByTestId("settings-link-kernel:mcp")).toBeNull()
  })

  it("a user without mcp_manager:personal_connection:write still has Connected tools for the clients", () => {
    setTokens(jwt(["mcp_manager:connection:read"]), "refresh")
    inApp(() => <SettingsSidebar />)
    expect(screen.getByTestId("settings-link-kernel:connected-tools")).toBeInTheDocument()
  })

  it("an admin reaches the org MCP servers through Connectors and also sees Connected tools", () => {
    setTokens(jwt(["*"]), "refresh")
    inApp(() => <SettingsSidebar />)
    expect(screen.getByTestId("settings-link-kernel:connectors").getAttribute("href")).toBe(
      "/settings/connectors",
    )
    expect(screen.getByTestId("settings-link-kernel:connected-tools")).toBeInTheDocument()
  })
})

describe("MyMcpConnectionsPage", () => {
  beforeEach(() => {
    setTokens(jwt(MEMBER_SCOPES), "refresh")
  })
  afterEach(() => {
    cleanup()
    clearAuth()
    BillingStateTestAccess.reset()
    vi.unstubAllGlobals()
  })

  const list = [
    row({
      id: "c-mine",
      slug: "my-hubspot",
      displayName: "My HubSpot",
      lastCheckedAt: "2026-10-07T10:00:00Z",
    }),
    row({
      id: "c-broken",
      slug: "my-linear",
      displayName: "My Linear",
      status: "failed",
      lastError: "401 Unauthorized",
    }),
    row({
      id: "c-org",
      slug: "org-jira",
      displayName: "Org Jira",
      ownershipScope: "org",
      ownerUserId: null,
    }),
    row({
      id: "c-theirs",
      slug: "their-notion",
      displayName: "Their Notion",
      ownerUserId: SOMEONE_ELSE,
    }),
  ]

  it("lists only the caller's personal connections, with their status and last test", async () => {
    recordingApi([["GET", "/apps/mcp-manager/connections", list]])
    inApp(() => <MyMcpConnectionsPage />)
    expect(await screen.findByTestId("my-mcp-row-my-hubspot")).toBeInTheDocument()
    expect(screen.getByTestId("my-mcp-row-my-linear")).toHaveTextContent("401 Unauthorized")
    expect(
      within(screen.getByTestId("my-mcp-row-my-linear")).getByTestId("mcp-status-failed"),
    ).toBeInTheDocument()
    expect(screen.queryByTestId("my-mcp-row-org-jira")).toBeNull()
    expect(screen.queryByTestId("my-mcp-row-their-notion")).toBeNull()
  })

  it("adds through the stepped flow forced to personal: no org choice, body says personal", async () => {
    const calls = recordingApi([
      ["GET", "/apps/mcp-manager/connections", []],
      [
        "POST",
        "/apps/mcp-manager/probe",
        {
          mode: "none",
          callbackUrl: "x",
          resource: "x",
          scopes: [],
          requiresClientSecret: false,
          issuer: null,
        },
      ],
      ["POST", "/connections/c-new/test", { ok: true, toolCount: 1, tools: [{ name: "echo" }] }],
      ["GET", "/connections/c-new/policy", []],
      ["PATCH", "/connections/c-new", { ok: true }],
      ["POST", "/apps/mcp-manager/connections", { id: "c-new" }],
    ])
    inApp(() => <MyMcpConnectionsPage />)
    fireEvent.click(await screen.findByTestId("my-mcp-add-btn"))
    const flow = await screen.findByTestId("mcp-add-flow")
    expect(within(flow).queryByTestId("mcp-ownership")).toBeNull()
    fireEvent.input(screen.getByTestId("mcp-add-url"), {
      target: { value: "https://mcp.example.com/mcp" },
    })
    fireEvent.click(screen.getByTestId("mcp-add-check"))
    fireEvent.click(await screen.findByTestId("mcp-add-connect"))
    // A personal server gets the same review, without per-tool choices (they need
    // mcp_manager:policy:write, an admin scope).
    expect(await screen.findByTestId("mcp-tools-review")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-tools-bulk")).toBeNull()
    fireEvent.click(screen.getByTestId("mcp-tools-review-done"))
    const create = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/apps/mcp-manager/connections"),
    )
    expect(create?.body).toMatchObject({ ownershipScope: "personal", transport: "http" })
    // Done returns to the list.
    expect(await screen.findByTestId("my-mcp-empty")).toBeInTheDocument()
  })

  it("a refused token reads 'Sign in again' with a sign-in; unreadable credentials say so, without one", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    const calls = recordingApi([
      [
        "GET",
        "/apps/mcp-manager/connections",
        [
          row({
            id: "c-re",
            slug: "re",
            displayName: "Re",
            status: "needs_reauth",
            lastError: "invalid_grant",
          }),
          row({
            id: "c-bad",
            slug: "bad",
            displayName: "Bad",
            status: "oauth_pending",
            secretsUnreadable: true,
            lastError: "cannot be decrypted",
          }),
        ],
      ],
      ["POST", "/connections/c-re/oauth/start", { authorizationUrl: "https://auth.example.com/a" }],
    ])
    inApp(() => <MyMcpConnectionsPage />)
    const re = await screen.findByTestId("my-mcp-row-re")
    expect(within(re).getByTestId("mcp-chip-needs_reauth")).toHaveTextContent("Sign in again")
    expect(re).toHaveTextContent("invalid_grant")
    const bad = screen.getByTestId("my-mcp-row-bad")
    expect(within(bad).getByTestId("mcp-chip-secrets_unreadable")).toBeInTheDocument()
    expect(within(bad).queryByTestId("my-mcp-signin")).toBeNull()
    fireEvent.click(within(re).getByTestId("my-mcp-signin"))
    await waitFor(() => expect(calls.some((c) => c.url.includes("/c-re/oauth/start"))).toBe(true))
    await waitFor(() => expect(open).toHaveBeenCalled())
    open.mockRestore()
  })

  it("test, disable, enable and delete act on the selected connection", async () => {
    const calls = recordingApi([
      [
        "GET",
        "/apps/mcp-manager/connections",
        [
          list[0],
          row({ id: "c-off", slug: "off", displayName: "Off", disabled: true, status: "disabled" }),
        ],
      ],
      ["POST", "/connections/c-mine/test", { ok: true, toolCount: 3 }],
      ["POST", "/connections/c-mine/disable", { ok: true }],
      ["POST", "/connections/c-off/enable", { ok: true }],
      ["DELETE", "/connections/c-mine", { ok: true }],
    ])
    inApp(() => <MyMcpConnectionsPage />)
    // Each action refetches the list, so rows are looked up afresh every time.
    const mine = () => screen.getByTestId("my-mcp-row-my-hubspot")
    await screen.findByTestId("my-mcp-row-my-hubspot")
    fireEvent.click(within(mine()).getByTestId("my-mcp-test"))
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/c-mine/test"))).toBe(true),
    )
    await waitFor(() => expect(within(mine()).getByTestId("my-mcp-toggle")).not.toBeDisabled())
    fireEvent.click(within(mine()).getByTestId("my-mcp-toggle"))
    await waitFor(() => expect(calls.some((c) => c.url.includes("/c-mine/disable"))).toBe(true))
    await waitFor(() =>
      expect(
        within(screen.getByTestId("my-mcp-row-off")).getByTestId("my-mcp-toggle"),
      ).not.toBeDisabled(),
    )
    fireEvent.click(within(screen.getByTestId("my-mcp-row-off")).getByTestId("my-mcp-toggle"))
    await waitFor(() => expect(calls.some((c) => c.url.includes("/c-off/enable"))).toBe(true))
    await waitFor(() => expect(within(mine()).getByTestId("my-mcp-delete")).not.toBeDisabled())
    fireEvent.click(within(mine()).getByTestId("my-mcp-delete"))
    fireEvent.click(await screen.findByTestId("my-mcp-delete-confirm"))
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.url.endsWith("/connections/c-mine")),
      ).toBe(true),
    )
  })

  it("an OAuth connection is not tested-and-deleted before sign-in: it opens the authorization page", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    const calls = recordingApi([
      ["GET", "/apps/mcp-manager/connections", []],
      [
        "POST",
        "/apps/mcp-manager/probe",
        {
          mode: "dcr",
          callbackUrl: "x",
          resource: "x",
          scopes: [],
          requiresClientSecret: false,
          issuer: "x",
        },
      ],
      [
        "POST",
        "/connections/c-oauth/oauth/start",
        { authorizationUrl: "https://auth.example.com/authorize?x=1" },
      ],
      ["POST", "/apps/mcp-manager/connections", { id: "c-oauth" }],
    ])
    inApp(() => <MyMcpConnectionsPage />)
    fireEvent.click(await screen.findByTestId("my-mcp-add-btn"))
    fireEvent.input(await screen.findByTestId("mcp-add-url"), {
      target: { value: "https://mcp.crm.example/mcp" },
    })
    fireEvent.click(screen.getByTestId("mcp-add-check"))
    fireEvent.click(await screen.findByTestId("mcp-add-signin"))
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://auth.example.com/authorize?x=1",
        "_blank",
        "noopener,noreferrer",
      ),
    )
    expect(calls.some((c) => c.url.includes("/test"))).toBe(false)
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    open.mockRestore()
  })
})
