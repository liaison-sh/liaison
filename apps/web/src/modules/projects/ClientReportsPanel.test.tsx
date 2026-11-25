// SPDX-License-Identifier: FSL-1.1-ALv2
// A project's client reports: nothing when there is none, a waiting draft read
// as the client will read it, staff-only sources and left-out items apart, and
// Send going through the server's gated tool, whose answer is shown as given.
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => ({ post: mocks.post }) }))

import { ClientReportsPanel, reportState } from "./ClientReportsPanel"

const DRAFT = {
  reportId: "r1",
  projectId: "p1",
  periodEnd: "2026-11-13",
  status: "draft",
  sections: [{ kind: "project_reports", heading: "This week", text: "The booking page is live." }],
  leftOut: [{ what: "Server move", why: "internal" }],
  sources: {
    tasks: [{ title: "Booking page", status: "done" }],
    pullRequests: [],
    threadMessages: [],
  },
  approvedAt: null,
  sentAt: null,
}

function serve(over: Record<string, unknown> = {}) {
  mocks.post.mockImplementation(async (_path: string, body: { toolName: string }) => {
    const answers: Record<string, unknown> = {
      "projects:client_reports_list": {
        reports: [{ reportId: "r1", periodEnd: "2026-11-13", status: "draft", sentAt: null }],
      },
      "projects:client_report_get": DRAFT,
      "projects:client_report_send": { message: "Waiting for approval: nothing was sent yet." },
      ...over,
    }
    return answers[body.toolName] ?? {}
  })
}

beforeEach(() => {
  mocks.post.mockReset()
})

describe("client reports panel", () => {
  it("shows nothing for a project with no report", async () => {
    serve({ "projects:client_reports_list": { reports: [] } })
    const r = render(() => <ClientReportsPanel projectId="p1" />)
    await waitFor(() => expect(mocks.post).toHaveBeenCalled())
    expect(r.queryByTestId("client-reports")).toBeNull()
  })

  it("a waiting draft reads as the client will read it, with its sources and left-out items for staff only", async () => {
    serve()
    const r = render(() => <ClientReportsPanel projectId="p1" />)
    fireEvent.click(await r.findByTestId("client-reports.toggle"))
    fireEvent.click(r.getByTestId("client-reports.item-r1"))
    expect((await r.findByTestId("client-report.state")).textContent).toBe("Waiting for a person")
    expect(r.getByTestId("client-report.section-project_reports").textContent).toContain(
      "The booking page is live.",
    )
    const staff = r.getByTestId("client-report.staff-only")
    expect(staff.textContent).toContain("Server move")
    expect(staff.textContent).toContain("1 tasks")
  })

  it("Send asks the server's gated tool and shows what it answered", async () => {
    serve()
    const r = render(() => <ClientReportsPanel projectId="p1" />)
    fireEvent.click(await r.findByTestId("client-reports.toggle"))
    fireEvent.click(r.getByTestId("client-reports.item-r1"))
    fireEvent.click(await r.findByTestId("client-report.send"))
    expect((await r.findByTestId("client-report.message")).textContent).toBe(
      "Waiting for approval: nothing was sent yet.",
    )
    expect(mocks.post).toHaveBeenCalledWith("/apps/run-tool", {
      toolName: "projects:client_report_send",
      params: { reportId: "r1" },
    })
  })

  it("names the four states", () => {
    expect(["draft", "approved", "sent", "rejected", "expired"].map(reportState)).toEqual([
      "waiting",
      "approved",
      "sent",
      "rejected",
      "rejected",
    ])
  })
})
