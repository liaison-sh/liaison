// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Documents list's Drafts entry: an unissued draft (an agent's, approved and waiting to be
// issued) is listed there and opens its document, while the other entries keep issued
// documents only.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const calls: Array<Record<string, unknown>> = []
const navigated: string[] = []
const DRAFT = {
  id: "d-1",
  type: "invoice",
  number: null,
  status: "draft",
  payment_status: "unpaid",
  counterparty_name: "Client Example",
  currency: "EUR",
  grand_total_minor: "600000",
  issued_at: null,
  channel: "manual",
}
const ISSUED = {
  ...DRAFT,
  id: "i-1",
  number: "F-2026-0001",
  status: "issued",
  issued_at: "2026-11-02 00:00:00+00",
}

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  currentPath: () => "/invoicing/documents/drafts",
  navigate: (path: string) => navigated.push(path),
  onEntityChange: () => () => {},
  fetchBlob: async () => new Blob(),
  openFile: async () => false,
  app: {
    invokeTool: async (_tool: string, args: Record<string, unknown>) => {
      calls.push(args)
      // The server's status filter: a status asked for returns only those rows.
      return args.status === "draft" ? [DRAFT] : [DRAFT, ISSUED]
    },
  },
}))

const { InvoicingDocumentsList } = await import("./DocumentsList")

afterEach(() => {
  cleanup()
  calls.length = 0
  navigated.length = 0
})

describe("the Documents list's Drafts entry", () => {
  it("lists the drafts, asked of the server by status, each linking to its document", async () => {
    render(() => <InvoicingDocumentsList entityId="drafts" />)
    await waitFor(() => expect(screen.getAllByTestId("invoicing-documents-row")).toHaveLength(1))
    expect(calls.some((c) => c.status === "draft")).toBe(true)
    const row = screen.getByTestId("invoicing-documents-row")
    expect(row.textContent).toContain("Client Example")
    fireEvent.click(row)
    expect(navigated).toEqual(["/invoicing/document/d-1"])
  })

  it("keeps drafts out of the All entry", async () => {
    render(() => <InvoicingDocumentsList entityId="all" />)
    await waitFor(() => expect(screen.getAllByTestId("invoicing-documents-row")).toHaveLength(1))
    expect(screen.getByTestId("invoicing-documents-row").textContent).toContain("F-2026-0001")
  })
})
