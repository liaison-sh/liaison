// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { PolicyTab } from "~/modules/mcp-manager/tabs/PolicyTab"
import { renderInApp } from "~/modules/mcp-manager/test-render"
import { mockApiClient } from "~/tests/helpers/mock-api"

const ID = "conn-1"
const ROLE_ADMIN = "11111111-1111-4111-8111-111111111111"
const ROLE_SUPPORT = "22222222-2222-4222-8222-222222222222"

function buildConn(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    slug: "linear",
    displayName: "Linear",
    transport: "http",
    ownershipScope: "org",
    managedBy: "ui",
    agentVisibility: "discoverable",
    exposeViaGateway: true,
    connectionDefaultPolicy: "gate_writes",
    rateCapPerMinute: null,
    disabled: false,
    status: "connected",
    toolCount: 0,
    authFlavor: "none",
    createdAt: "2026-05-24T00:00:00Z",
    updatedAt: "2026-05-24T00:00:00Z",
    ...over,
  }
}

describe("PolicyTab", () => {
  afterEach(cleanup)

  it("renders the three default-policy radios + toggles", async () => {
    // buildConn() is org-scoped, so RoleOverridesEditor mounts and fetches the
    // connection-wide policy row plus /admin/roles. Both must be routed or the
    // resources reject outside any assertion. `/policy` is a strict suffix of
    // the connection URL, so it has to come first.
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/policy`]: [],
      [`/apps/mcp-manager/connections/${ID}`]: buildConn(),
      "/admin/roles": [],
    })
    renderInApp(() => <PolicyTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-policy-radio-auto")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-policy-radio-gate_writes")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-policy-radio-gate_all")).toBeInTheDocument()
    // Each policy reads in words, never its raw value.
    const radios = screen.getByTestId("mcp-policy-default-radios")
    expect(radios.textContent).toContain("Changes need approval")
    expect(radios.textContent).not.toMatch(/gate_writes|gate_all/)
    expect(screen.getByTestId("mcp-policy-agent-visibility")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-policy-expose-gateway")).toBeInTheDocument()
  })

  it("shows the role-overrides table only when ownership = org", async () => {
    // mockApiClient matches the FIRST substring that hits the URL, so the
    // more-specific `/policy` entry must come before the broader connection
    // path — otherwise `listToolPolicies` would receive the connection row.
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/policy`]: [],
      [`/apps/mcp-manager/connections/${ID}`]: buildConn({ ownershipScope: "org" }),
      "/admin/roles": [],
    })
    renderInApp(() => <PolicyTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-policy-role-overrides")).toBeInTheDocument()
  })

  it("hides the role-overrides table on personal connections", async () => {
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}`]: buildConn({ ownershipScope: "personal" }),
    })
    renderInApp(() => <PolicyTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-policy-radio-auto")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-policy-role-overrides")).not.toBeInTheDocument()
  })

  it("seeds the role-overrides table from an existing connection-wide policy row", async () => {
    // Order matters — `/policy` is a strict suffix of the connection URL, so
    // it must be listed first or the connection fixture would shadow it.
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/policy`]: [
        {
          toolName: "*",
          overrideDecision: null,
          roleOverrides: [{ roleId: ROLE_ADMIN, decision: "auto" }],
        },
      ],
      [`/apps/mcp-manager/connections/${ID}`]: buildConn({ ownershipScope: "org" }),
      "/admin/roles": [
        { id: ROLE_ADMIN, name: "admin" },
        { id: ROLE_SUPPORT, name: "support" },
      ],
    })
    renderInApp(() => <PolicyTab connectionId={ID} />)
    expect(await screen.findByTestId(`mcp-policy-role-row-${ROLE_ADMIN}`)).toBeInTheDocument()
    const decision = screen.getByTestId("mcp-policy-role-decision-0") as HTMLSelectElement
    expect(decision.value).toBe("auto")
  })

  it("Add role override persists via PUT to the connection-wide policy row", async () => {
    // Hand-rolled fetch so the test can both serve GETs AND capture the
    // outgoing PUT body. The mockApiClient helper only routes by URL — it
    // discards method + body, which we need to assert on here.
    const puts: Array<{ url: string; body: unknown }> = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      if (method === "PUT" && url.includes(`/apps/mcp-manager/connections/${ID}/policy`)) {
        puts.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes(`/apps/mcp-manager/connections/${ID}/policy`)) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes(`/apps/mcp-manager/connections/${ID}`)) {
        return new Response(JSON.stringify({ data: buildConn({ ownershipScope: "org" }) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/admin/roles")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: ROLE_ADMIN, name: "admin" },
              { id: ROLE_SUPPORT, name: "support" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 })
    }) as typeof fetch

    try {
      renderInApp(() => <PolicyTab connectionId={ID} />)
      const add = (await screen.findByTestId("mcp-policy-role-add")) as HTMLButtonElement
      // The button is rendered immediately but stays disabled until the
      // /admin/roles resource lands. Wait for the click to actually fire.
      await waitFor(() => expect(add.disabled).toBe(false))
      fireEvent.click(add)
      await waitFor(() => expect(puts.length).toBeGreaterThan(0))
      const sent = puts[puts.length - 1].body as {
        toolName: string
        roleOverrides: Array<{ roleId: string; decision: string }>
      }
      expect(sent.toolName).toBe("*")
      expect(sent.roleOverrides).toHaveLength(1)
      expect(sent.roleOverrides[0].decision).toBe("auto")
      // First unused role from the /admin/roles list — admin in this fixture.
      expect(sent.roleOverrides[0].roleId).toBe(ROLE_ADMIN)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
