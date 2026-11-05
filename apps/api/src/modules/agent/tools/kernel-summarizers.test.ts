// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  summarizeCaptureBusinessKnowledge,
  summarizeContactsExport,
} from "~/modules/agent/tools/kernel-summarizers"

const ctx = {} as Parameters<typeof summarizeContactsExport>[1]

describe("kernel approval summaries", () => {
  it("names a contacts export's scope", async () => {
    const tagged = await summarizeContactsExport({ tag: "dealers" }, ctx)
    expect(tagged.title).toBe('Export contacts tagged "dealers"')
    const all = await summarizeContactsExport({}, ctx)
    expect(all.title).toBe("Export contacts to a CSV file")
    expect(all.lines[0]).toContain("every contact you can see")
  })

  it("titles a knowledge capture by the document", async () => {
    const s = await summarizeCaptureBusinessKnowledge(
      { title: "Support inbox", body: "Write to support@example.com." },
      ctx,
    )
    expect(s.title).toBe("Add to company knowledge: Support inbox")
    expect(s.lines).toContain("Write to support@example.com.")
  })
})
