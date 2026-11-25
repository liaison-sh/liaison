// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A freeze renders a filled source and compares the text the layout drew with
// the source's own text: wrapping, tables and page breaks pass, a run that
// differs refuses. The hash is the stored bytes' hash.
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createRichTextMethods } from "~/modules/apps/sandbox/bridge/rich-text"
import { freezeTextMatches, renderRichTextForFreeze } from "./rich-text"

const long = "The supplier delivers the website, its hosting and a year of support. ".repeat(160)
const body = {
  blocks: [
    { type: "heading", level: 1, text: "Statement of work {{agreement.number}}" },
    { type: "paragraph", text: long },
    {
      type: "table",
      columns: [{ header: "Item" }, { header: "Days" }],
      rows: [
        ["Design", "4"],
        ["Build", "{{days}}"],
      ],
    },
    { type: "paragraph", text: "Signed for {{client.name}}." },
  ],
}
const record = {
  agreement: { number: "AG-2026-001" },
  days: "12",
  client: { name: "Maison Morel" },
}

describe("freezing a rich-text source", () => {
  it("the stored file's hash is the hash of the bytes, and the drawn text equals the source's", async () => {
    const out = await renderRichTextForFreeze({ body, record })
    expect(out.sha256).toBe(createHash("sha256").update(out.bytes).digest("hex"))
    expect(out.pageCount).toBeGreaterThan(1)
    expect(out.blanks).toEqual([])
    expect(out.sourceText).toContain("AG-2026-001")
    expect(out.sourceText).toContain("Maison Morel")
    expect(freezeTextMatches(out.sourceText, out.layoutText)).toBe(true)
  })

  it("a list of written items is drawn and its text checked like a paragraph's", async () => {
    const out = await renderRichTextForFreeze({
      body: {
        blocks: [
          { type: "heading", text: "Scope" },
          { type: "list", items: ["Design for {{client.name}}", "Build", "Launch"] },
        ],
      },
      record,
    })
    expect(out.sourceText).toContain("Design for Maison Morel")
    expect(out.sourceText).toContain("Launch")
    expect(freezeTextMatches(out.sourceText, out.layoutText)).toBe(true)
  })

  it("a text run that differs from the source refuses the freeze", async () => {
    const out = await renderRichTextForFreeze({ body, record })
    const dropped = out.layoutText.replace("Build", "")
    expect(freezeTextMatches(out.sourceText, dropped)).toBe(false)
    const changed = out.layoutText.replace("12", "21")
    expect(freezeTextMatches(out.sourceText, changed)).toBe(false)
  })

  it("a blank field is named, by its label", async () => {
    const out = await renderRichTextForFreeze({
      body,
      record: { agreement: { number: "AG-2026-001" }, days: "12" },
      labelOf: (p) => (p === "client.name" ? "Client name" : p),
    })
    expect(out.blanks.map((b) => b.label)).toEqual(["Client name"])
  })
})

describe("the rich_text_render bridge method", () => {
  const methods = (scopes: string[]) =>
    createRichTextMethods({
      appName: "agreements",
      callerScopes: scopes,
    } as unknown as BridgeContext)

  it("answers the bytes, their hash and the text check for a run holding the app's scope", async () => {
    const raw = await methods(["agreements:agreements:write"]).rich_text_render(
      JSON.stringify({ body, data: record }),
    )
    const out = JSON.parse(raw) as {
      status: string
      bytesBase64: string
      sha256: string
      textMatches: boolean
    }
    expect(out.status).toBe("ok")
    expect(out.textMatches).toBe(true)
    expect(createHash("sha256").update(Buffer.from(out.bytesBase64, "base64")).digest("hex")).toBe(
      out.sha256,
    )
  })

  it("refuses a run that holds no scope of the calling app", async () => {
    const out = JSON.parse(
      await methods(["invoicing:documents:read"]).rich_text_render(JSON.stringify({ body })),
    ) as { status: string; error: { code: string } }
    expect(out).toMatchObject({ status: "error", error: { code: "SCOPE_REQUIRED" } })
  })
})
