// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { summarizeSupplierInvoiceUpload } from "./summarizers"

describe("summarizeSupplierInvoiceUpload", () => {
  it("names the supplier and shows the figures that will be booked, in major units", async () => {
    const s = await summarizeSupplierInvoiceUpload({
      file_id: "file-1",
      supplier_name: "Fournisseur Exemple",
      invoice_number: "F-77",
      invoice_date: "2026-07-01",
      due_date: "2026-07-31",
      amount_minor: "12345",
      tax_minor: "2058",
      currency: "EUR",
    })
    expect(s.title).toBe("Import the bill from Fournisseur Exemple into Pennylane")
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Invoice number: F-77/)
    expect(joined).toMatch(/Invoice date: 2026-07-01/)
    expect(joined).toMatch(/Due date: 2026-07-31/)
    expect(joined).toMatch(/Total including tax: 123.45 EUR/)
    expect(joined).toMatch(/Of which tax: 20.58 EUR/)
  })

  it("says plainly that approving books the bill in Pennylane", async () => {
    const s = await summarizeSupplierInvoiceUpload({
      file_id: "file-2",
      supplier_name: "Vendor Co",
      invoice_date: "2026-07-02",
      amount_minor: "100",
    })
    expect(s.lines.join("\n")).toMatch(
      /imports the bill and its PDF into Pennylane's accounts payable/,
    )
    expect(s.subtitle).toMatch(/books a supplier invoice in Pennylane/)
  })
})
