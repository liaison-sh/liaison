// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { AuditTab } from "~/modules/mcp-manager/tabs/AuditTab"
import { renderInApp } from "~/modules/mcp-manager/test-render"
import { mockApiClient } from "~/tests/helpers/mock-api"

const ID = "conn-1"

describe("AuditTab", () => {
  afterEach(cleanup)

  it("Empty: shows empty-state copy when no rows", async () => {
    mockApiClient({ [`/apps/mcp-manager/connections/${ID}/audit`]: [] })
    renderInApp(() => <AuditTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-audit-empty")).toBeInTheDocument()
  })

  it("Populated: renders one row per audit event", async () => {
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/audit`]: [
        {
          id: "a1",
          timestamp: "2026-05-24T00:00:00Z",
          app: "mcp",
          entity: "tool",
          action: "call",
          actorId: "u1",
          actorType: "user",
          changes: { outcome: "ok" },
        },
      ],
    })
    renderInApp(() => <AuditTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-audit-row-a1")).toBeInTheDocument()
  })

  it("filter dropdown wires to the request query", async () => {
    let capturedUrl = ""
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    try {
      renderInApp(() => <AuditTab connectionId={ID} />)
      const f = await screen.findByTestId("mcp-audit-decision-filter")
      fireEvent.change(f, { target: { value: "denied" } })
      await new Promise((r) => setTimeout(r, 10))
      expect(capturedUrl).toContain("decision=denied")
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
