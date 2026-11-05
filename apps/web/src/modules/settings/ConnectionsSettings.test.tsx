// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Connections merged "MCP" and "My connections": the clients
// connected to Liaison come first for everyone; the viewer's own MCP servers
// follow, only for holders of mcp_manager:personal_connection:write.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import ConnectionsSettings from "~/modules/settings/ConnectionsSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

const ME = "00000000-0000-4000-8000-00000000a001"

function jwt(scopes: string[]): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: ME,
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

function stubApi(): string[] {
  const urls: string[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const json = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    if (url.endsWith("/api/mcp/connect-info")) return json({ baseUrl: "https://example.test" })
    if (url.endsWith("/api/mcp/connections")) {
      return json([
        { id: "k1", label: "Claude Code", createdAt: "2026-10-01T00:00:00Z", lastUsedAt: null },
      ])
    }
    if (url.endsWith("/api/apps/mcp-manager/connections")) {
      return json([
        {
          id: "c-mine",
          slug: "my-hubspot",
          displayName: "My HubSpot",
          transport: "http",
          ownershipScope: "personal",
          ownerUserId: ME,
          disabled: false,
          status: "connected",
          toolCount: 2,
          lastCheckedAt: null,
          lastError: null,
        },
      ])
    }
    return json([])
  })
  return urls
}

function renderPage() {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <ConnectionsSettings />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("Settings > Connections", () => {
  afterEach(() => {
    cleanup()
    clearAuth()
    vi.unstubAllGlobals()
  })

  it("shows the connected clients first, then the viewer's own MCP servers", async () => {
    stubApi()
    setTokens(jwt(["mcp_manager:connection:read", "mcp_manager:personal_connection:write"]), "r")
    renderPage()

    const clients = screen.getByTestId("connections-clients")
    const personal = screen.getByTestId("connections-personal-servers")
    // Document order: clients, then personal servers.
    expect(
      clients.compareDocumentPosition(personal) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    expect(within(clients).getByTestId("mcp-connect-section")).toBeInTheDocument()
    await waitFor(() =>
      expect(within(clients).getByTestId("mcp-connection-row-k1")).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(within(personal).getByTestId("my-mcp-row-my-hubspot")).toBeInTheDocument(),
    )
  })

  it("without the personal connection scope, shows the clients block only", async () => {
    const urls = stubApi()
    setTokens(jwt(["mcp_manager:connection:read"]), "r")
    renderPage()

    await waitFor(() => expect(screen.getByTestId("mcp-connection-row-k1")).toBeInTheDocument())
    expect(screen.queryByTestId("connections-personal-servers")).toBeNull()
    expect(screen.queryByTestId("my-mcp-connections-page")).toBeNull()
    expect(urls.some((u) => u.includes("/apps/mcp-manager/connections"))).toBe(false)
  })
})
