// SPDX-License-Identifier: FSL-1.1-ALv2
// The Work section of a company's page: its projects and deals, an amount only
// with deal access, and its own line when the read fails.
import { fireEvent, render } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DealRead } from "~/modules/projects/deal-api"

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  openEntity: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => ({ post: mocks.post }) }))
vi.mock("~/modules/shell/entity-opener", () => ({ openEntity: mocks.openEntity }))

import { CompanyWorkPanel } from "./CompanyWorkPanel"

function deal(withValues: boolean): DealRead {
  return {
    task: {
      id: "t7",
      key: "SALES-7",
      title: "Lumen rollout",
      projectId: "p1",
      stage: "Proposal",
      ownerId: null,
    },
    deal: {
      companyId: "co-lumen",
      companyName: "Lumen",
      contactId: null,
      outcome: "open",
      nextStep: null,
      lostReason: null,
      closedAt: null,
      closedBy: null,
    },
    ...(withValues
      ? {
          values: {
            amountMinor: 1_500_000,
            currency: "EUR",
            amountPeriod: "once" as const,
            probability: null,
          },
        }
      : {}),
  }
}

beforeEach(() => {
  mocks.post.mockReset()
  mocks.openEntity.mockReset()
})

describe("CompanyWorkPanel", () => {
  it("shows the company's projects and deals, with the amount only under deal access", async () => {
    mocks.post.mockResolvedValueOnce({
      projects: [{ id: "p9", name: "Lumen fit-out", key: "LUM" }],
      deals: [deal(true)],
    })
    const withAccess = render(() => <CompanyWorkPanel entityId="co-lumen" />)
    const amount = await withAccess.findByTestId("company-work-panel.deal-t7.amount")
    expect(amount.textContent).toContain("15,000")
    fireEvent.click(withAccess.getByTestId("company-work-panel.project-p9"))
    expect(mocks.openEntity).toHaveBeenCalledWith(
      expect.anything(),
      "projects",
      "project",
      "p9",
      "Lumen fit-out",
    )
    withAccess.unmount()

    mocks.post.mockResolvedValueOnce({ projects: [], deals: [deal(false)] })
    const blind = render(() => <CompanyWorkPanel entityId="co-lumen" />)
    expect((await blind.findByTestId("company-work-panel.deal-t7.amount")).textContent).toBe(
      "Needs deal access",
    )
    expect(blind.getByTestId("company-work-panel.deal-t7").textContent).toContain(
      "SALES-7 Lumen rollout",
    )
  })

  it("says so when there is nothing, and has its own line when the read fails", async () => {
    mocks.post.mockResolvedValueOnce({ projects: [], deals: [] })
    const empty = render(() => <CompanyWorkPanel entityId="co-quiet" />)
    expect((await empty.findByTestId("company-work-panel.empty")).textContent).toBe(
      "No project or deal for this company yet.",
    )
    empty.unmount()
    mocks.post.mockRejectedValueOnce(new Error("down"))
    const failed = render(() => <CompanyWorkPanel entityId="co-lumen" />)
    expect((await failed.findByTestId("company-work-panel.error")).textContent).toBe(
      "Could not read this company's projects and deals.",
    )
  })
})
