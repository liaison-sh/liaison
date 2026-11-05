// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { workbookBytes } from "./__test-helpers__/workbook"
import {
  driveHasText,
  driveTypeLabel,
  GOOGLE_SHEET_MIME,
  googleExportMimeFor,
  SPREADSHEET_MAX_ROWS,
  XLSX_MIME,
  xlsxToText,
} from "./drive-text"

describe("drive-text", () => {
  it("knows which Drive types have a text form", () => {
    expect(driveHasText(XLSX_MIME)).toBe(true)
    expect(driveHasText(GOOGLE_SHEET_MIME)).toBe(true)
    expect(driveHasText("application/vnd.google-apps.document")).toBe(true)
    expect(driveHasText("text/markdown")).toBe(true)
    expect(driveHasText("application/pdf")).toBe(false)
    expect(driveHasText("application/vnd.google-apps.drawing")).toBe(false)
    expect(driveHasText("text/html")).toBe(false)
    expect(driveHasText(undefined)).toBe(false)
    expect(googleExportMimeFor(GOOGLE_SHEET_MIME)).toBe("text/csv")
    expect(driveTypeLabel("application/pdf")).toBe("PDF")
    expect(driveTypeLabel("image/png")).toBe("image")
  })

  it("turns a workbook into CSV, sheet by sheet, with every column of the sheet", async () => {
    const text = await xlsxToText(
      workbookBytes([
        {
          name: "Request",
          rows: [
            ["Field", "Value"],
            ["Part", "GW1N-9"],
            ["Quantity", 25],
          ],
        },
        { name: "Notes", rows: [["Note"], ["Ship, before Friday"]] },
      ]),
      "Gowin Sample Request Form.xlsx",
    )
    expect(text).toBe(
      [
        "Sheet: Request",
        "Field,Value",
        "Part,GW1N-9",
        "Quantity,25",
        "",
        "Sheet: Notes",
        "Note",
        '"Ship, before Friday"',
      ].join("\n"),
    )
  })

  it("cuts a long workbook and says so", async () => {
    const rows: unknown[][] = [["n"]]
    for (let i = 0; i < SPREADSHEET_MAX_ROWS + 5; i++) rows.push([i])
    const text = await xlsxToText(workbookBytes([{ name: "Big", rows }]), "big.xlsx")
    expect(text.split("\n").filter((l) => /^\d+$/.test(l))).toHaveLength(SPREADSHEET_MAX_ROWS)
    expect(text).toContain("[Cut: the workbook is longer than")
  })

  it("refuses bytes that are not a workbook", async () => {
    await expect(xlsxToText(new TextEncoder().encode("not a zip"), "x.xlsx")).rejects.toThrow()
  })
})
