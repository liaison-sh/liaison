// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { UsageTab } from "~/modules/mcp-manager/tabs/UsageTab"
import { renderInApp } from "~/modules/mcp-manager/test-render"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"
import { mockApiClient } from "~/tests/helpers/mock-api"

const ID = "conn-1"

describe("UsageTab", () => {
  afterEach(() => {
    cleanup()
    BillingStateTestAccess.reset()
  })

  it("returns null on self-hosted (managed-only feature)", () => {
    BillingStateTestAccess.setMode("self_hosted")
    mockApiClient({})
    const { container } = renderInApp(() => <UsageTab connectionId={ID} />)
    expect(container.innerHTML).not.toContain("mcp-usage-tab")
  })

  it("managed: renders three KPI cards + sparkline", async () => {
    BillingStateTestAccess.setMode("managed")
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/usage`]: {
        calls: 12,
        errors: 1,
        p95LatencyMs: 220,
        bytesIn: 100,
        bytesOut: 200,
        topTools: [{ toolName: "echo", calls: 5 }],
        windowMs: 86400000,
      },
    })
    renderInApp(() => <UsageTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-usage-kpi-calls")).toHaveTextContent("12")
    expect(screen.getByTestId("mcp-usage-kpi-errors")).toHaveTextContent("1")
    expect(screen.getByTestId("mcp-usage-kpi-p95")).toHaveTextContent("220")
    expect(screen.getByTestId("mcp-usage-sparkline")).toBeInTheDocument()
  })
})
