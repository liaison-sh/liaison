// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A server's page is sections, not tabs (S25): Tools & policy, Activity,
// Usage (managed edition only) and Configuration; its header carries the
// status and the sign-in that fixes a refused token.
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectionDetail } from "~/modules/mcp-manager/ConnectionDetail"
import { renderInApp } from "~/modules/mcp-manager/test-render"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"

const ID = "conn-1"

const CONN = {
  id: ID,
  slug: "crm",
  displayName: "Crm",
  transport: "http",
  ownershipScope: "org",
  managedBy: "ui",
  agentVisibility: "discoverable",
  exposeViaGateway: true,
  connectionDefaultPolicy: "gate_writes",
  rateCapPerMinute: null,
  disabled: false,
  httpUrl: "https://mcp.crm.example",
  authFlavor: "oauth_static",
  customHeaderNames: [],
  createdAt: "2026-10-24T00:00:00Z",
  updatedAt: "2026-10-24T00:00:00Z",
}

type Call = { method: string; url: string }

function serve(status: string): Call[] {
  const calls: Call[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({ method, url })
    const json = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    if (method === "DELETE") return json({ ok: true })
    if (url.includes("/oauth/start"))
      return json({ authorizationUrl: "https://auth.crm.example/a" })
    if (url.includes("/policy")) return json([])
    if (url.includes("/tools")) return json([{ name: "search_objects", description: "Reads" }])
    if (url.includes("/audit")) return json([])
    if (url.includes("/usage")) {
      return json({
        calls: 3,
        errors: 0,
        p95LatencyMs: 10,
        bytesIn: 0,
        bytesOut: 0,
        topTools: [],
        windowMs: 1,
      })
    }
    if (url.endsWith(`/connections/${ID}`)) return json(CONN)
    if (url.endsWith("/apps/mcp-manager/connections")) {
      return json([{ ...CONN, status, toolCount: 9, lastError: null }])
    }
    return json(null)
  })
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  BillingStateTestAccess.reset()
})

describe("ConnectionDetail", () => {
  it("renders sections, not tabs; no Usage section on self-host", async () => {
    BillingStateTestAccess.setMode("self_hosted")
    serve("connected")
    renderInApp(() => <ConnectionDetail connectionId={ID} />)
    expect(await screen.findByTestId("mcp-detail-header")).toHaveTextContent("Crm")
    for (const id of ["tools", "activity", "configuration"]) {
      expect(screen.getByTestId(`mcp-detail-section-${id}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId("mcp-detail-section-usage")).toBeNull()
    expect(screen.queryByTestId("mcp-detail-tabs")).toBeNull()
    // The tools Liaison holds, with their policy, in the Tools section.
    const tools = screen.getByTestId("mcp-detail-section-tools")
    expect(await within(tools).findByTestId("mcp-tool-row-search_objects")).toBeInTheDocument()
    expect(within(tools).getByTestId("mcp-policy-default-radios")).toBeInTheDocument()
    expect(await screen.findByTestId("mcp-chip-connected")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-detail-signin")).toBeNull()
  })

  it("shows Usage on the managed edition", async () => {
    BillingStateTestAccess.setMode("managed")
    serve("connected")
    renderInApp(() => <ConnectionDetail connectionId={ID} />)
    expect(await screen.findByTestId("mcp-detail-section-usage")).toBeInTheDocument()
  })

  it("a refused token: the header says Sign in again and its button starts the sign-in", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    const calls = serve("needs_reauth")
    renderInApp(() => <ConnectionDetail connectionId={ID} />)
    expect(await screen.findByTestId("mcp-chip-needs_reauth")).toHaveTextContent("Sign in again")
    expect(screen.getByTestId("mcp-detail-status-detail")).toHaveTextContent(/9 tools/)
    fireEvent.click(screen.getByTestId("mcp-detail-signin"))
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://auth.crm.example/a",
        "_blank",
        "noopener,noreferrer",
      ),
    )
    expect(calls.some((c) => c.url.includes(`/connections/${ID}/oauth/start`))).toBe(true)
  })

  it("Remove asks once more, deletes, and tells the page", async () => {
    const removed = vi.fn()
    const calls = serve("connected")
    renderInApp(() => <ConnectionDetail connectionId={ID} onRemoved={removed} />)
    fireEvent.click(await screen.findByTestId("mcp-detail-remove"))
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    fireEvent.click(screen.getByTestId("mcp-detail-remove-confirm"))
    await waitFor(() => expect(removed).toHaveBeenCalled())
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(new RegExp(`/connections/${ID}$`)),
    ])
  })
})
