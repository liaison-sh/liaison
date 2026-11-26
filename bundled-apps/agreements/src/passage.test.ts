// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { AgreementsCtx } from "./ctx"
import { memoryDb } from "./memory-db.testutil"
import { agreementPassageGet, cutSection } from "./passage"

const TEXT = [
  "Statement of work",
  "1. Scope",
  "A website in two languages.",
  "8. Price",
  "8.1 Fixed part: 42 000 EUR.",
  "8.2 Further work is billed at 700 EUR per day.",
  "Days are counted in half days.",
  "9. Term",
  "Twelve months.",
].join("\n")

async function world(sourceText: string | null) {
  const db = memoryDb()
  const { id: agreementId } = await db.insert("agreements", {
    number: "AG-2026-014",
    status: "signed",
  })
  const { id: versionId } = await db.insert("agreement_versions", {
    agreement_id: agreementId,
    number: 2,
    status: "signed",
    sha256: "c".repeat(64),
    source_text: sourceText,
    source_kind: "template",
    knowledge_document_id: "doc-k",
  })
  const ctx = { orgId: "o", userId: "u", db } as unknown as AgreementsCtx
  return { ctx, versionId, db }
}

describe("agreement passage", () => {
  it("cuts a section from the signed text, to the next heading of its level", async () => {
    const w = await world(TEXT)
    const out = await agreementPassageGet(w.ctx, { version_id: w.versionId, section: "8.2" })
    expect(out).toMatchObject({
      status: "ok",
      agreement: { number: "AG-2026-014" },
      version: { number: 2, sha256: "c".repeat(64) },
      passage: {
        section: "8.2",
        text: "8.2 Further work is billed at 700 EUR per day.\nDays are counted in half days.",
      },
    })
    expect(cutSection(TEXT, "8")).toBe(
      "8. Price\n8.1 Fixed part: 42 000 EUR.\n8.2 Further work is billed at 700 EUR per day.\nDays are counted in half days.",
    )
  })

  it("reads the version's own text, never its Knowledge copy", async () => {
    const w = await world(TEXT)
    const reads: string[] = []
    const findOne = w.db.findOne.bind(w.db)
    ;(w.db as unknown as { findOne: typeof findOne }).findOne = async (e: string, id: string) => {
      reads.push(e)
      return findOne(e, id)
    }
    await agreementPassageGet(w.ctx, { version_id: w.versionId, section: "1" })
    expect(reads.sort()).toEqual(["agreement_versions", "agreements"])
  })

  it("a version with no readable text answers NOT_READABLE and quotes nothing", async () => {
    const w = await world(null)
    const out = await agreementPassageGet(w.ctx, { version_id: w.versionId, section: "8.2" })
    expect(out).toMatchObject({ status: "error", error: { code: "NOT_READABLE" } })
    expect(JSON.stringify(out)).not.toContain("passage")
  })

  it("a section the text does not hold is named with the sections it does hold", async () => {
    const w = await world(TEXT)
    const out = await agreementPassageGet(w.ctx, { version_id: w.versionId, section: "8.3" })
    expect(out).toMatchObject({ status: "error", error: { code: "SECTION_NOT_FOUND" } })
    expect(JSON.stringify(out)).toContain("1, 8, 8.1, 8.2, 9")
  })

  it("an unknown version is not found", async () => {
    const w = await world(TEXT)
    const out = await agreementPassageGet(w.ctx, {
      version_id: "99999999-0000-4000-8000-000000000009",
      section: "1",
    })
    expect(out).toMatchObject({ status: "error", error: { code: "NOT_FOUND" } })
  })
})
