// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Pending Approval tab the sidebar links to: the waiting invoicing requests, oldest first,
// each opening the document it acts on.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const navigated: string[] = []
let rows: unknown[] = []

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: (path: string) => navigated.push(path),
  app: { invokeTool: async () => ({ items: rows }) },
}))

const { InvoicingPendingApprovals } = await import("./PendingList")

afterEach(() => {
  cleanup()
  navigated.length = 0
  rows = []
})

describe("pending approval tab", () => {
  it("lists the waiting requests oldest first and opens the draft a request issues", async () => {
    rows = [
      {
        id: "b",
        tool_name: "invoicing:invoice_issue",
        summary: "Issue invoice for Maison Lune, 7,812.00 EUR",
        created_at: "2026-10-31",
        document_id: "draft-2",
      },
      {
        id: "a",
        tool_name: "invoicing:credit_note_create_and_issue",
        summary: "Issue credit note for Maison Lune",
        created_at: "2026-10-30",
        document_id: null,
      },
    ]
    render(() => <InvoicingPendingApprovals />)
    await waitFor(() => expect(screen.getByTestId("pending-row-b")).toBeTruthy())
    const list = screen.getByTestId("invoicing-pending")
    const ids = [...list.querySelectorAll("li")].map((li) => li.getAttribute("data-testid"))
    expect(ids).toEqual(["pending-row-a", "pending-row-b"])
    expect(screen.queryByTestId("pending-open-a")).toBeNull()
    fireEvent.click(screen.getByTestId("pending-open-b"))
    expect(navigated).toEqual(["/invoicing/document/draft-2"])
  })

  it("says nothing is waiting when the list is empty", async () => {
    render(() => <InvoicingPendingApprovals />)
    await waitFor(() => expect(screen.getByTestId("invoicing-pending-empty")).toBeTruthy())
  })
})
