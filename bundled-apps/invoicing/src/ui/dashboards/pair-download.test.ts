// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { downloadPair } from "./pair-download"

const pdf = (n: string) => new Blob([n], { type: "application/pdf" })

function deps(over: Partial<Parameters<typeof downloadPair>[1]> = {}) {
  const saved: Array<{ name: string; type: string }> = []
  return {
    saved,
    deps: {
      resolveUrl: async (id: string) => `https://files/${id}`,
      fetchBlob: async (url: string) => pdf(url),
      save: (b: Blob, name: string) => {
        saved.push({ name, type: b.type })
      },
      ...over,
    },
  }
}

describe("downloadPair", () => {
  test("saves both halves as SEPARATE files, named by document number", async () => {
    // Never merged: one PDF containing both halves would show the software
    // lines to the customs officer reading the goods invoice.
    const d = deps()
    const res = await downloadPair([{ id: "1", number: "INV-3456" }, { id: "2", number: "INV-3457" }], d.deps)
    expect(d.saved.map((s) => s.name)).toEqual(["INV-3456.pdf", "INV-3457.pdf"])
    expect(res.saved).toHaveLength(2)
    expect(res.failed).toEqual([])
  })

  test("still delivers the good half when the other fails", async () => {
    // All-or-nothing would leave the operator with nothing and no idea which
    // half broke.
    const d = deps({ resolveUrl: async (id: string) => (id === "2" ? null : `https://files/${id}`) })
    const res = await downloadPair([{ id: "1", number: "INV-3456" }, { id: "2", number: "INV-3457" }], d.deps)
    expect(res.saved).toEqual(["INV-3456"])
    expect(res.failed).toEqual(["INV-3457"])
    expect(d.saved).toHaveLength(1)
  })

  test("survives a throwing fetch and reports that half failed", async () => {
    const d = deps({
      fetchBlob: async (url: string) => {
        if (url.endsWith("/2")) throw new Error("network")
        return pdf(url)
      },
    })
    const res = await downloadPair([{ id: "1", number: "A" }, { id: "2", number: "B" }], d.deps)
    expect(res).toEqual({ saved: ["A"], failed: ["B"] })
  })

  test("forces the pdf mime when the server serves something vaguer", async () => {
    // The inline file route serves non-image mimes as octet-stream; saved as-is
    // the browser will not preview it.
    const d = deps({ fetchBlob: async () => new Blob(["x"], { type: "application/octet-stream" }) })
    await downloadPair([{ id: "1", number: "A" }], d.deps)
    expect(d.saved[0]!.type).toBe("application/pdf")
  })

  test("downloads sequentially, so a browser cannot drop the second one", async () => {
    const order: string[] = []
    const d = deps({
      fetchBlob: async (url: string) => {
        order.push(`start:${url}`)
        await new Promise((r) => setTimeout(r, 5))
        order.push(`end:${url}`)
        return pdf(url)
      },
    })
    await downloadPair([{ id: "1" }, { id: "2" }], d.deps)
    expect(order).toEqual(["start:https://files/1", "end:https://files/1", "start:https://files/2", "end:https://files/2"])
  })

  test("falls back to the id when a document has no number yet", async () => {
    const d = deps()
    await downloadPair([{ id: "draft-9", number: null }], d.deps)
    expect(d.saved[0]!.name).toBe("draft-9.pdf")
  })
})
