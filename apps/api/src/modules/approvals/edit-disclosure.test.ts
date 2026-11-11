// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { approvalSummarySchema } from "@liaison/shared"
import { withDisclosureLine } from "~/modules/approvals/edit"

const lines = (n: number) => Array.from({ length: n }, (_, i) => `change ${i + 1}`)

describe("withDisclosureLine", () => {
  it("keeps every line of a long dashboard card, the disclosure last", () => {
    const out = withDisclosureLine(
      { kind: "dashboard_edit", title: "Edit dashboard", lines: lines(20) },
      "Edited by Ana",
    )
    expect(out.lines).toHaveLength(21)
    expect(out.lines.at(-1)).toBe("Edited by Ana")
    expect(approvalSummarySchema.safeParse(out).success).toBe(true)
  })

  it("caps a dashboard card at its kind's limit", () => {
    const out = withDisclosureLine(
      { kind: "dashboard_update", title: "Rebuild dashboard", lines: lines(50) },
      "Edited by Ana",
    )
    expect(out.lines).toHaveLength(50)
    expect(out.lines[48]).toBe("change 49")
    expect(approvalSummarySchema.safeParse(out).success).toBe(true)
  })

  it("keeps any other card to 8 lines", () => {
    const out = withDisclosureLine(
      { kind: "ticket_reply", title: "Reply", lines: lines(8) },
      "Edited by Ana",
    )
    expect(out.lines).toEqual([...lines(7), "Edited by Ana"])
    expect(approvalSummarySchema.safeParse(out).success).toBe(true)
  })

  it("leaves the summary as it is without a disclosure", () => {
    const summary = { kind: "dashboard_edit", title: "Edit", lines: lines(12) }
    expect(withDisclosureLine(summary, null)).toBe(summary)
  })
})
