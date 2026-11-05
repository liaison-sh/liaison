// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpConnectionsList } from "~/modules/mcp-manager/McpConnectionsList"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { mockApiClient } from "~/tests/helpers/mock-api"

function renderList(props: Parameters<typeof McpConnectionsList>[0] = {}) {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <McpConnectionsList {...props} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

function row(over: Record<string, unknown>) {
  return {
    id: "c1",
    slug: "docs",
    displayName: "Docs",
    transport: "http",
    ownershipScope: "org",
    managedBy: "ui",
    agentVisibility: "discoverable",
    exposeViaGateway: true,
    connectionDefaultPolicy: "gate_writes",
    rateCapPerMinute: null,
    disabled: false,
    status: "connected",
    toolCount: 14,
    lastCallAgo: null,
    lastError: null,
    ...over,
  }
}

describe("McpConnectionsList (§11.7 state-coverage matrix)", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("states come from the data: connected, needs sign-in again, unreadable credentials; org rows only", async () => {
    const onSignIn = vi.fn()
    const onSelect = vi.fn()
    mockApiClient({
      "/apps/mcp-manager/connections": [
        row({ id: "a", slug: "docs", displayName: "Docs", status: "connected", toolCount: 14 }),
        row({
          id: "b",
          slug: "crm",
          displayName: "Crm",
          status: "needs_reauth",
          toolCount: 9,
          lastError: "invalid_grant",
        }),
        row({
          id: "c",
          slug: "wiki",
          displayName: "Wiki",
          status: "oauth_pending",
          secretsUnreadable: true,
          lastError: "The connection's stored secrets cannot be decrypted",
        }),
        row({ id: "d", slug: "mine", displayName: "Mine", ownershipScope: "personal" }),
      ],
    })
    renderList({ onSignIn, onSelect })
    const docs = await screen.findByTestId("mcp-row-docs")
    expect(within(docs).getByTestId("mcp-chip-connected")).toHaveTextContent("Connected")
    expect(within(docs).getByText(/14 tools/)).toBeInTheDocument()
    expect(within(docs).queryByTestId("mcp-reauth-btn")).toBeNull()

    const crm = screen.getByTestId("mcp-row-crm")
    expect(within(crm).getByTestId("mcp-chip-needs_reauth")).toHaveTextContent("Sign in again")
    expect(within(crm).getByTestId("mcp-row-detail")).toHaveTextContent(/9 tools/)
    fireEvent.click(within(crm).getByTestId("mcp-reauth-btn"))
    expect(onSignIn).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }))

    const wiki = screen.getByTestId("mcp-row-wiki")
    expect(within(wiki).getByTestId("mcp-chip-secrets_unreadable")).toHaveTextContent(
      "Can't read saved credentials",
    )
    expect(within(wiki).getByTestId("mcp-row-detail")).toHaveTextContent(/cannot be decrypted/)
    // Signing in would be refused while the secrets cannot be read.
    expect(within(wiki).queryByTestId("mcp-oauth-resume-btn")).toBeNull()
    expect(within(wiki).queryByTestId("mcp-reauth-btn")).toBeNull()

    expect(screen.queryByTestId("mcp-row-mine")).toBeNull()
    fireEvent.click(within(docs).getByTestId("mcp-open-docs"))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }))
  })

  it("re-reads the list when the person comes back from the sign-in tab", async () => {
    let status = "oauth_pending"
    let gets = 0
    vi.stubGlobal("fetch", async () => {
      gets++
      return new Response(JSON.stringify({ data: [row({ status })] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    renderList()
    expect(await screen.findByTestId("mcp-chip-oauth_pending")).toBeInTheDocument()
    status = "connected"
    window.dispatchEvent(new Event("focus"))
    expect(await screen.findByTestId("mcp-chip-connected")).toBeInTheDocument()
    expect(gets).toBe(2)
  })

  it("a last call in milliseconds reads as a relative time", async () => {
    mockApiClient({ "/apps/mcp-manager/connections": [row({ lastCallAgo: 5 * 60_000 })] })
    renderList()
    const r = await screen.findByTestId("mcp-row-docs")
    expect(within(r).getByTestId("mcp-row-detail")).toHaveTextContent(/5m ago/)
  })

  it("Empty: renders empty-state CTA when no connections", async () => {
    mockApiClient({ "/apps/mcp-manager/connections": [] })
    renderList()
    expect(await screen.findByTestId("mcp-empty-state")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-add-first-cta")).toHaveTextContent(/add your first/i)
  })

  it("Populated: renders one row per connection with status dot + scope + transport + tool count", async () => {
    mockApiClient({
      "/apps/mcp-manager/connections": [
        {
          id: "c1",
          slug: "linear",
          displayName: "Linear",
          transport: "http",
          ownershipScope: "org",
          managedBy: "ui",
          agentVisibility: "discoverable",
          exposeViaGateway: true,
          connectionDefaultPolicy: "auto",
          rateCapPerMinute: null,
          disabled: false,
          status: "connected",
          toolCount: 23,
          lastCallAgo: "2m",
        },
      ],
    })
    renderList()
    const row = await screen.findByTestId("mcp-row-linear")
    expect(within(row).getByTestId("mcp-status-connected")).toBeInTheDocument()
    expect(within(row).getByText(/23 tools/)).toBeInTheDocument()
    expect(within(row).getByText(/last call 2m/)).toBeInTheDocument()
  })

  it("Failed: shows muted-red banner when at least one connection failed (calm UI)", async () => {
    mockApiClient({
      "/apps/mcp-manager/connections": [
        {
          id: "c1",
          slug: "linear",
          displayName: "Linear",
          transport: "http",
          ownershipScope: "org",
          managedBy: "ui",
          agentVisibility: "discoverable",
          exposeViaGateway: true,
          connectionDefaultPolicy: "auto",
          rateCapPerMinute: null,
          disabled: false,
          status: "failed",
          toolCount: 0,
        },
      ],
    })
    renderList()
    const banner = await screen.findByTestId("mcp-failed-banner")
    expect(banner).toBeInTheDocument()
    // Calm UI: no animated icon, no shouty colors. We assert the class string
    // contains "rose-" (muted) and NOT "red-500" / "animate-bounce".
    expect(banner.className).toMatch(/rose/)
    expect(banner.className).not.toMatch(/animate-(bounce|ping)/)
  })

  it("OAuth-pending: surfaces a Resume button on a connection mid-OAuth", async () => {
    mockApiClient({
      "/apps/mcp-manager/connections": [
        {
          id: "c1",
          slug: "linear",
          displayName: "Linear",
          transport: "http",
          ownershipScope: "org",
          managedBy: "ui",
          agentVisibility: "discoverable",
          exposeViaGateway: true,
          connectionDefaultPolicy: "auto",
          rateCapPerMinute: null,
          disabled: false,
          status: "oauth_pending",
          toolCount: 0,
        },
      ],
    })
    renderList()
    const row = await screen.findByTestId("mcp-row-linear")
    expect(within(row).getByTestId("mcp-oauth-pending")).toBeInTheDocument()
    const resume = within(row).getByTestId("mcp-oauth-resume-btn")
    expect(resume.getAttribute("aria-label")).toMatch(/resume/i)
  })

  it("Failed: renders failed-banner when the API call rejects", async () => {
    // Force fetch to throw — the ErrorBoundary should catch and show the banner.
    const origFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch
    try {
      renderList()
      // A read retries a network error twice (up to about 3 s of waits) before it fails.
      await waitFor(
        () => {
          expect(screen.getByTestId("mcp-failed-banner")).toBeInTheDocument()
        },
        { timeout: 5_000 },
      )
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it("Loading: renders the loading skeleton while connections are fetching", async () => {
    // never-resolving promise — Suspense shows skeleton
    const origFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    try {
      renderList()
      expect(await screen.findByTestId("mcp-loading-skeleton")).toBeInTheDocument()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
