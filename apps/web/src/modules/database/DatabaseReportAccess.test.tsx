// SPDX-License-Identifier: FSL-1.1-ALv2

import type { DatabaseDomainAccessView } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn() } as Record<"get" | "put", ReturnType<typeof vi.fn>>,
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))

import DatabaseReportAccess from "./DatabaseReportAccess"

const FINANCE = "11111111-1111-4111-8111-111111111111"

function view(over: Partial<DatabaseDomainAccessView> = {}): DatabaseDomainAccessView {
  return {
    adapter: "warehouse",
    domains: [
      {
        domain: "returns",
        reads: [{ name: "open_returns", description: "Open returns" }],
        catalogTier: null,
        rule: null,
        effectiveTier: "internal",
      },
      {
        domain: "revenue",
        reads: [{ name: "revenue_by_month", description: "Revenue by month" }],
        catalogTier: "confidential",
        rule: null,
        effectiveTier: "confidential",
      },
    ],
    domainAccess: { legacy: { tier: "restricted", users: [] } },
    roles: [{ id: FINANCE, name: "finance" }],
    members: [],
    ...over,
  }
}

beforeEach(() => {
  state.api.get.mockReset()
  state.api.put.mockReset()
})

describe("DatabaseReportAccess", () => {
  it("lists each domain with its reads, the catalog default, and the raw-query note", async () => {
    state.api.get.mockResolvedValue(view())
    render(() => <DatabaseReportAccess />)
    await screen.findByTestId("database-report-access-row-revenue")
    expect(screen.getByTestId("database-report-access-row-returns").textContent).toContain(
      "open_returns",
    )
    const revenueTier = screen.getByTestId(
      "database-report-access-tier-revenue",
    ) as HTMLSelectElement
    expect(revenueTier.value).toBe("confidential")
    expect(revenueTier.textContent).toContain("(")
    expect(screen.getByTestId("database-report-access-raw-note")).toBeTruthy()
    // Confidential by catalog default: the role picker shows, nobody chosen yet.
    expect(screen.getByTestId("database-report-access-roles-revenue")).toBeTruthy()
    expect((screen.getByTestId("database-report-access-save") as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it("saves a tier change as one map, keeping rules for domains the catalog no longer has", async () => {
    state.api.get.mockResolvedValue(view())
    state.api.put.mockResolvedValue(view())
    render(() => <DatabaseReportAccess />)
    const tier = (await screen.findByTestId(
      "database-report-access-tier-returns",
    )) as HTMLSelectElement
    fireEvent.change(tier, { target: { value: "restricted" } })
    expect(screen.getByTestId("database-report-access-users-returns")).toBeTruthy()
    fireEvent.click(screen.getByTestId("database-report-access-save"))
    await waitFor(() => expect(state.api.put).toHaveBeenCalledTimes(1))
    expect(state.api.put.mock.calls[0]?.[0]).toBe("/database/domain-access")
    expect(state.api.put.mock.calls[0]?.[1]).toEqual({
      domainAccess: {
        legacy: { tier: "restricted", users: [] },
        returns: { tier: "restricted" },
      },
    })
  })

  it("a domain set back to its catalog default carries no rule", async () => {
    state.api.get.mockResolvedValue(view({ domainAccess: { revenue: { tier: "internal" } } }))
    state.api.put.mockResolvedValue(view({ domainAccess: {} }))
    render(() => <DatabaseReportAccess />)
    const tier = (await screen.findByTestId(
      "database-report-access-tier-revenue",
    )) as HTMLSelectElement
    expect(tier.value).toBe("internal")
    fireEvent.change(tier, { target: { value: "confidential" } })
    fireEvent.click(screen.getByTestId("database-report-access-save"))
    await waitFor(() => expect(state.api.put).toHaveBeenCalledTimes(1))
    expect(state.api.put.mock.calls[0]?.[1]).toEqual({ domainAccess: {} })
  })

  it("shows a load failure inline", async () => {
    state.api.get.mockRejectedValue(new Error("boom"))
    render(() => <DatabaseReportAccess />)
    expect((await screen.findByTestId("database-report-access-load-error")).textContent).toContain(
      "boom",
    )
  })
})
