// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, test } from "bun:test"
import { sha256Hex } from "../einvoicing/backfill-sha256"
import { createMockDb } from "../test-db"
import { base64, utf8Bytes } from "./bytes"
import { legalOriginalsVerify } from "./verify"

function bytesOf(s: string): number[] {
  return utf8Bytes(s)
}

function setup(files: Record<string, string | null>) {
  const db = createMockDb()
  const reads: Array<Record<string, unknown>> = []
  const ctx = {
    db,
    async files_getAttachmentBytes(args: string) {
      const p = JSON.parse(args) as {
        fileId: string
        allowedParents: Array<Record<string, unknown>>
      }
      reads.push(p)
      const content = files[p.fileId]
      if (content === undefined) throw new Error("file not found")
      return JSON.stringify({ bytesBase64: content === null ? "" : base64(bytesOf(content)) })
    },
  }
  return { db, ctx, reads }
}

async function original(
  db: ReturnType<typeof createMockDb>,
  id: string,
  fileId: string,
  content: string,
  at: string,
) {
  await db.insert("legal_originals", {
    id,
    document_id: `doc-${id}`,
    kind: "issued_pdf",
    file_id: fileId,
    sha256: sha256Hex(bytesOf(content)),
    byte_size: content.length,
    recorded_at: at,
  })
}

describe("legal_originals_verify", () => {
  test("matching bytes are intact; a changed or missing file is listed", async () => {
    const { db, ctx, reads } = setup({ f1: "%PDF-one", f2: "%PDF-tampered", f3: null })
    await original(
      db,
      "00000000-0000-4000-8000-000000000a01",
      "f1",
      "%PDF-one",
      "2026-11-01T00:00:00Z",
    )
    await original(
      db,
      "00000000-0000-4000-8000-000000000a02",
      "f2",
      "%PDF-two",
      "2026-11-02T00:00:00Z",
    )
    await original(
      db,
      "00000000-0000-4000-8000-000000000a03",
      "f3",
      "%PDF-three",
      "2026-11-03T00:00:00Z",
    )
    await original(
      db,
      "00000000-0000-4000-8000-000000000a04",
      "f4",
      "%PDF-four",
      "2026-11-04T00:00:00Z",
    )
    const r = await legalOriginalsVerify(ctx, {})
    if (r.status !== "ok") throw new Error(JSON.stringify(r))
    expect(r.checked).toBe(4)
    expect(r.intact).toBe(1)
    expect(r.mismatched.map((m) => m.legal_original_id)).toEqual([
      "00000000-0000-4000-8000-000000000a02",
    ])
    expect(r.mismatched[0]?.actual_sha256).toBe(sha256Hex(bytesOf("%PDF-tampered")))
    expect(r.unreadable.map((u) => u.legal_original_id).sort()).toEqual([
      "00000000-0000-4000-8000-000000000a03",
      "00000000-0000-4000-8000-000000000a04",
    ])
    expect(r.next_offset).toBeNull()
    // Read through the legal original's own file parent.
    expect(reads[0]?.allowedParents).toEqual([
      {
        app: "invoicing",
        entityType: "legal_original",
        entityId: "00000000-0000-4000-8000-000000000a01",
      },
    ])
  })

  test("one document, an empty (never rendered) row is skipped, paging continues", async () => {
    const { db, ctx } = setup({ f1: "%PDF-one", f2: "%PDF-two" })
    await original(
      db,
      "00000000-0000-4000-8000-000000000b01",
      "f1",
      "%PDF-one",
      "2026-11-01T00:00:00Z",
    )
    await original(
      db,
      "00000000-0000-4000-8000-000000000b02",
      "f2",
      "%PDF-two",
      "2026-11-02T00:00:00Z",
    )
    await db.insert("legal_originals", {
      id: "00000000-0000-4000-8000-000000000b03",
      document_id: "doc-empty",
      kind: "facturx",
      file_id: null,
      sha256: null,
      recorded_at: "2026-11-03T00:00:00Z",
    })
    const one = await legalOriginalsVerify(ctx, {
      document_id: "doc-00000000-0000-4000-8000-000000000b02",
    })
    if (one.status !== "ok") throw new Error("x")
    expect([one.checked, one.intact]).toEqual([1, 1])
    const first = await legalOriginalsVerify(ctx, { limit: 1 })
    if (first.status !== "ok") throw new Error("x")
    expect(first.next_offset).toBe(1)
    const all = await legalOriginalsVerify(ctx, { limit: 10 })
    if (all.status !== "ok") throw new Error("x")
    expect([all.checked, all.intact, all.next_offset]).toEqual([2, 2, null])
  })
})
