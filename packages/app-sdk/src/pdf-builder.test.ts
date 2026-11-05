// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { DrawCommandsSchema } from "@liaison/shared" // barrel, not a subpath (C3)
import { PdfBuilder, rgb } from "./pdf-builder"

describe("PdfBuilder", () => {
  it("records commands that satisfy the shared schema", () => {
    const pdf = new PdfBuilder()
    pdf.setMetadata({ title: "Invoice" })
    const f = pdf.embedFont("Helvetica")
    const page = pdf.addPage(595, 842)
    page.drawText("Hello", { x: 40, y: 800, size: 11, font: f, color: rgb(0, 0, 0) })
    page.drawLine({ start: { x: 40, y: 700 }, end: { x: 555, y: 700 }, thickness: 0.5 })
    const cmds = pdf.build()
    expect(DrawCommandsSchema.safeParse(cmds).success).toBe(true)
    expect(cmds.filter((c) => c.op === "drawText")).toHaveLength(1)
    expect(cmds.find((c) => c.op === "addPage")).toMatchObject({ width: 595, height: 842 })
  })

  it("assigns distinct page indices in order", () => {
    const pdf = new PdfBuilder()
    const p0 = pdf.addPage(595, 842)
    const p1 = pdf.addPage(595, 842)
    p0.drawText("a", { x: 1, y: 1, size: 10, font: "f" })
    p1.drawText("b", { x: 1, y: 1, size: 10, font: "f" })
    const cmds = pdf.build()
    expect((cmds.find((c) => c.op === "drawText" && c.text === "a") as { page: number }).page).toBe(
      0,
    )
    expect((cmds.find((c) => c.op === "drawText" && c.text === "b") as { page: number }).page).toBe(
      1,
    )
  })

  it("embedImage + drawImage record commands that satisfy the shared schema", () => {
    const pdf = new PdfBuilder()
    const fileId = "5b9f6e1e-9d1c-4a3a-8f0e-9c1a2b3c4d5e"
    const ref = pdf.embedImage(fileId, "logo")
    expect(ref).toBe("logo")
    const page = pdf.addPage(595, 842)
    page.drawImage({ ref, x: 50, y: 780, maxWidth: 140, maxHeight: 48 })
    const cmds = pdf.build()
    expect(DrawCommandsSchema.safeParse(cmds).success).toBe(true)
    expect(cmds.find((c) => c.op === "embedImage")).toMatchObject({ ref: "logo", fileId })
    expect(cmds.find((c) => c.op === "drawImage")).toMatchObject({
      ref: "logo",
      page: 0,
      x: 50,
      y: 780,
      maxWidth: 140,
      maxHeight: 48,
    })
  })

  it("embedImage defaults ref to the fileId when none is given", () => {
    const pdf = new PdfBuilder()
    const fileId = "5b9f6e1e-9d1c-4a3a-8f0e-9c1a2b3c4d5e"
    const ref = pdf.embedImage(fileId)
    expect(ref).toBe(fileId)
  })
})
