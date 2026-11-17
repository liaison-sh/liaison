// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A contract signed before Liaison is filed from its PDF as imported: no version,
// no signature, no evidence and no level; it says "Imported, signed outside
// Liaison", and text read from the PDF is kept as unverified.

import { describe, expect, it } from "bun:test"
import { agreementGet } from "./agreements"
import type { AgreementsCtx } from "./ctx"
import { agreementImport, IMPORTED_LABEL } from "./import"
import { memoryDb } from "./memory-db.testutil"

const PERSON = "11111111-1111-4111-8111-111111111111"
const UPLOAD = "44444444-4444-4444-8444-444444444444"
const KEPT = "55555555-5555-4555-8555-555555555555"

function world(readable = true) {
  const db = memoryDb()
  const emitted: Array<{ entity: string; action: string }> = []
  const ctx: AgreementsCtx = {
    orgId: "org",
    userId: PERSON,
    db,
    turn: { get: async () => ({ agentId: null }) },
    kernel: {
      caller: async () => ({ kind: "person", userId: PERSON, roleIds: [], holds: {} }),
    } as unknown as AgreementsCtx["kernel"],
    today: "2026-11-16",
    emit: async (e) => {
      emitted.push({ entity: e.entity, action: e.action })
      return null
    },
    files_attachToParent: async () => {
      if (!readable) throw new Error("source file not found or not readable")
      return { id: KEPT, filename: "msa.pdf", mimeType: "application/pdf", sizeBytes: 900 }
    },
  }
  return { db, ctx, emitted }
}

describe("importing a past contract", () => {
  it("files the PDF as imported, signed outside Liaison, with no evidence and no level", async () => {
    const { db, ctx, emitted } = world()
    const out = (await agreementImport(ctx, {
      kind: "msa",
      title: "Framework agreement 2024",
      file_id: UPLOAD,
      signed_on: "2024-03-01",
      renews_on: "2027-03-01",
      unverified_text: "Article 1. Purpose ...",
    })) as {
      status: string
      agreement: Record<string, unknown>
      message: string
    }
    expect(out.status).toBe("ok")
    expect(out.agreement).toMatchObject({
      status: "imported",
      status_note: IMPORTED_LABEL,
      file_id: KEPT,
      level: null,
      evidence: null,
      text: "unverified",
    })
    expect(out.message).toContain("Imported, signed outside Liaison")
    expect(out.message).toContain("unverified")
    const id = String(out.agreement.id)
    const row = (await db.findOne("agreements", id)) as Record<string, unknown>
    expect(row.status).toBe("imported")
    expect(row.signed_at).toBe("2024-03-01")
    expect(row.imported_text).toBe("Article 1. Purpose ...")
    expect(await db.findMany("agreement_versions", { where: { agreement_id: id } })).toHaveLength(0)
    expect(await db.findMany("evidence_packages", {})).toHaveLength(0)
    expect(emitted.map((e) => e.action)).toEqual(["imported"])
    const got = (await agreementGet(ctx, { id })) as { agreement: Record<string, unknown> }
    expect(got.agreement.status_note).toBe(IMPORTED_LABEL)
  })

  it("an import without its PDF, or one whose PDF the caller cannot read, files nothing", async () => {
    const none = world()
    expect(
      await agreementImport(none.ctx, { kind: "nda", title: "Old NDA", file_id: "" }),
    ).toMatchObject({ status: "error", error: { code: "FILE_REQUIRED" } })
    const unreadable = world(false)
    const out = await agreementImport(unreadable.ctx, {
      kind: "nda",
      title: "Old NDA",
      file_id: UPLOAD,
    })
    expect(out).toMatchObject({ status: "error", error: { code: "FILE_NOT_READABLE" } })
    const rows = (await unreadable.db.findMany("agreements", {})) as Array<{ status: string }>
    expect(rows.every((r) => r.status !== "imported")).toBe(true)
  })

  it("a change request is never imported", async () => {
    const { ctx } = world()
    expect(
      await agreementImport(ctx, { kind: "change_request", title: "x", file_id: UPLOAD }),
    ).toMatchObject({ status: "error", error: { code: "INVALID_KIND" } })
  })
})
