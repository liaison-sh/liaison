// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConfigurationTab } from "~/modules/mcp-manager/tabs/ConfigurationTab"
import { renderInApp } from "~/modules/mcp-manager/test-render"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"
import { mockApiClient } from "~/tests/helpers/mock-api"

const ID = "conn-1"

describe("ConfigurationTab", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    BillingStateTestAccess.reset()
  })

  const base = {
    id: ID,
    slug: "parts",
    displayName: "Parts",
    transport: "http",
    ownershipScope: "org",
    managedBy: "ui",
    agentVisibility: "discoverable",
    exposeViaGateway: true,
    connectionDefaultPolicy: "gate_writes",
    rateCapPerMinute: null,
    disabled: false,
    httpUrl: "https://tools.parts.example/mcp",
    createdAt: "2026-10-24T00:00:00Z",
    updatedAt: "2026-10-24T00:00:00Z",
  }

  it("a token server: header names shown, values write-only; a new token and header edits save as one patch", async () => {
    const patches: unknown[] = []
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") patches.push(JSON.parse(String(init.body)))
      return new Response(
        JSON.stringify({
          data: { ...base, authFlavor: "bearer", customHeaderNames: ["X-Workspace"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    renderInApp(() => <ConfigurationTab connectionId={ID} />)
    expect(((await screen.findByTestId("mcp-header-name-0")) as HTMLInputElement).value).toBe(
      "X-Workspace",
    )
    expect((screen.getByTestId("mcp-header-value-0") as HTMLInputElement).value).toBe("")
    expect(screen.getByTestId("mcp-config-credentials-save")).toBeDisabled()
    fireEvent.input(screen.getByTestId("mcp-config-bearer-token"), { target: { value: "tok-2" } })
    fireEvent.click(screen.getByTestId("mcp-header-remove-0"))
    fireEvent.click(screen.getByTestId("mcp-config-credentials-save"))
    await waitFor(() =>
      expect(patches).toEqual([{ bearerToken: "tok-2", customHeaders: { "X-Workspace": null } }]),
    )
  })

  it("an OAuth server has no token or header editor", async () => {
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}`]: { ...base, authFlavor: "oauth_dcr" },
    })
    renderInApp(() => <ConfigurationTab connectionId={ID} />)
    await screen.findByTestId("mcp-config-display-name")
    expect(screen.queryByTestId("mcp-config-credentials")).toBeNull()
  })

  it("env-managed connections render with a 'from .env' chip + disabled base config", async () => {
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}`]: {
        id: ID,
        slug: "linear",
        displayName: "Linear (env)",
        transport: "http",
        ownershipScope: "org",
        managedBy: "env",
        agentVisibility: "discoverable",
        exposeViaGateway: true,
        connectionDefaultPolicy: "auto",
        rateCapPerMinute: null,
        disabled: false,
        status: "connected",
        toolCount: 5,
        httpUrl: "http://x",
        authFlavor: "none",
        createdAt: "2026-05-24T00:00:00Z",
        updatedAt: "2026-05-24T00:00:00Z",
      },
    })
    renderInApp(() => <ConfigurationTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-managed-by-env-chip")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-config-display-name")).toBeDisabled()
    expect(screen.getByTestId("mcp-config-http-url")).toBeDisabled()
  })

  it("rate-cap field shows managed-only chip on self-hosted", async () => {
    BillingStateTestAccess.setMode("self_hosted")
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}`]: {
        id: ID,
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
        toolCount: 5,
        httpUrl: "http://x",
        authFlavor: "none",
        createdAt: "2026-05-24T00:00:00Z",
        updatedAt: "2026-05-24T00:00:00Z",
      },
    })
    renderInApp(() => <ConfigurationTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-config-ratecap-managed-only")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-config-ratecap")).toBeDisabled()
  })
})
