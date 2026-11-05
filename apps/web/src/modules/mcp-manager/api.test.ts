// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import * as api from "~/modules/mcp-manager/api"

interface CallRecord {
  method: string
  path: string
  body?: unknown
}

function makeApi(): { client: ApiClient; calls: CallRecord[] } {
  const calls: CallRecord[] = []
  const stub = (method: string) =>
    vi.fn(async (path: string, body?: unknown) => {
      calls.push({ method, path, body })
      // Return a shape sufficient for every helper under test (none of them
      // inspect the body in this file — we only assert path/method/payload).
      return [] as unknown
    })
  const client = {
    get: stub("GET"),
    post: stub("POST"),
    put: stub("PUT"),
    patch: stub("PATCH"),
    delete: stub("DELETE"),
    getEnvelope: stub("GET"),
    rawPost: stub("POST"),
  } as unknown as ApiClient
  return { client, calls }
}

describe("mcp-manager api helpers", () => {
  let client: ApiClient
  let calls: CallRecord[]

  beforeEach(() => {
    const made = makeApi()
    client = made.client
    calls = made.calls
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("listConnections calls GET /apps/mcp-manager/connections", async () => {
    await api.listConnections(client)
    expect(calls).toEqual([
      { method: "GET", path: "/apps/mcp-manager/connections", body: undefined },
    ])
  })

  it("getConnection encodes the id", async () => {
    await api.getConnection(client, "abc/def")
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/apps/mcp-manager/connections/abc%2Fdef",
    })
  })

  it("createConnection POSTs the body verbatim", async () => {
    const body = { slug: "linear", displayName: "Linear", transport: "http" as const }
    await api.createConnection(client, body)
    expect(calls[0]).toEqual({ method: "POST", path: "/apps/mcp-manager/connections", body })
  })

  it("patchConnection sends PATCH with the body", async () => {
    await api.patchConnection(client, "c1", { displayName: "New" })
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/apps/mcp-manager/connections/c1",
      body: { displayName: "New" },
    })
  })

  it("deleteConnection sends DELETE", async () => {
    await api.deleteConnection(client, "c1")
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/apps/mcp-manager/connections/c1" })
  })

  it("testConnection POSTs /:id/test", async () => {
    await api.testConnection(client, "c1")
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/apps/mcp-manager/connections/c1/test",
    })
  })

  it("disableConnection POSTs /:id/disable", async () => {
    await api.disableConnection(client, "c1")
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/apps/mcp-manager/connections/c1/disable",
    })
  })

  it("enableConnection POSTs /:id/enable", async () => {
    await api.enableConnection(client, "c1")
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/apps/mcp-manager/connections/c1/enable",
    })
  })

  it("getConnectionsSummary derives counts from the live list", async () => {
    const listMock = vi.fn(async () => [
      {
        id: "1",
        slug: "a",
        displayName: "a",
        transport: "http",
        ownershipScope: "org",
        managedBy: "ui",
        agentVisibility: "discoverable",
        exposeViaGateway: true,
        connectionDefaultPolicy: "auto",
        rateCapPerMinute: null,
        disabled: false,
        status: "connected",
        toolCount: 0,
      },
      {
        id: "2",
        slug: "b",
        displayName: "b",
        transport: "http",
        ownershipScope: "org",
        managedBy: "ui",
        agentVisibility: "discoverable",
        exposeViaGateway: true,
        connectionDefaultPolicy: "auto",
        rateCapPerMinute: null,
        disabled: true,
        status: "connected",
        toolCount: 0,
      },
      {
        id: "3",
        slug: "c",
        displayName: "c",
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
      {
        id: "4",
        slug: "d",
        displayName: "d",
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
      {
        id: "5",
        slug: "e",
        displayName: "e",
        transport: "http",
        ownershipScope: "org",
        managedBy: "ui",
        agentVisibility: "discoverable",
        exposeViaGateway: true,
        connectionDefaultPolicy: "auto",
        rateCapPerMinute: null,
        disabled: false,
        status: "needs_reauth",
        toolCount: 0,
      },
    ])
    const c = { ...client, get: listMock } as unknown as ApiClient
    const sum = await api.getConnectionsSummary(c)
    expect(sum).toEqual({
      total: 5,
      connected: 1,
      failed: 1,
      disabled: 1,
      oauthPending: 1,
      needsReauth: 1,
    })
  })

  it("probeMcpServer POSTs the URL to /probe and saves nothing", async () => {
    await api.probeMcpServer(client, "https://mcp.example.com/mcp")
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/apps/mcp-manager/probe",
        body: { url: "https://mcp.example.com/mcp" },
      },
    ])
  })

  it("listConnectionTools GETs /:id/tools", async () => {
    await api.listConnectionTools(client, "c1")
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/apps/mcp-manager/connections/c1/tools",
    })
  })

  it("listToolPolicies GETs /:id/policy", async () => {
    await api.listToolPolicies(client, "c1")
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/apps/mcp-manager/connections/c1/policy",
    })
  })

  it("patchToolPolicy PUTs the upsert body", async () => {
    await api.patchToolPolicy(client, "c1", { toolName: "echo", overrideDecision: "gate" })
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/apps/mcp-manager/connections/c1/policy",
      body: { toolName: "echo", overrideDecision: "gate" },
    })
  })

  it("deleteToolPolicy PUTs a clearing upsert", async () => {
    await api.deleteToolPolicy(client, "c1", "echo")
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/apps/mcp-manager/connections/c1/policy",
      body: { toolName: "echo", overrideDecision: null, roleOverrides: [] },
    })
  })

  it("startOAuth POSTs /:id/oauth/start and returns an https authorization URL", async () => {
    vi.mocked(client.post).mockResolvedValueOnce({
      authorizationUrl: "https://idp.example/authorize?x=1",
    })
    const result = await api.startOAuth(client, "c1")
    expect(result.authorizationUrl).toBe("https://idp.example/authorize?x=1")
    expect(calls).toHaveLength(0)
    expect(client.post).toHaveBeenCalledWith("/apps/mcp-manager/connections/c1/oauth/start")
  })

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "not a url",
    "vbscript:x",
    "http://idp.example/authorize",
  ])("startOAuth refuses the non-http authorization URL %s", async (authorizationUrl) => {
    vi.mocked(client.post).mockResolvedValueOnce({ authorizationUrl })
    await expect(api.startOAuth(client, "c1")).rejects.toThrow(/unsafe authorization URL/)
  })

  it("startOAuth POSTs the right path", async () => {
    vi.mocked(client.post).mockImplementationOnce(async (path: string) => {
      calls.push({ method: "POST", path })
      return { authorizationUrl: "https://idp.example/a" } as never
    })
    await api.startOAuth(client, "c1")
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/apps/mcp-manager/connections/c1/oauth/start",
    })
  })

  it("getConnectionAudit builds query string from filters", async () => {
    await api.getConnectionAudit(client, "c1", { from: "2026-01-01", decision: "ok", limit: 50 })
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/apps/mcp-manager/connections/c1/audit?from=2026-01-01&decision=ok&limit=50",
    })
  })

  it("getOrgAudit hits /audit with no connection id", async () => {
    await api.getOrgAudit(client, { decision: "denied" })
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/apps/mcp-manager/audit?decision=denied",
    })
  })

  it("getConnectionUsage defaults to 24h window", async () => {
    await api.getConnectionUsage(client, "c1")
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/apps/mcp-manager/connections/c1/usage?window=24h",
    })
  })

  it("getConnectionUsage respects the explicit window", async () => {
    await api.getConnectionUsage(client, "c1", { window: "1h" })
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/apps/mcp-manager/connections/c1/usage?window=1h",
    })
  })
})
