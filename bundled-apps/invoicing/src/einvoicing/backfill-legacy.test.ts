// SPDX-License-Identifier: FSL-1.1-ALv2
//
// einvoicing_backfill_legacy_originals: every imported legacy document gets a hashed
// `legacy_import` legal original (a copy of the imported file on its own row), a document whose
// PDF a later re-render replaced is pointed back at the imported file, batches stay under a byte
// budget, and a second run finds nothing left. The file bridges are faked at the boundary; the
// database is the bridge-shaped in-memory mock.
import { describe, expect, test } from "bun:test"
import { createMockDb, type MockDb } from "../test-db"
import { type LegacyBackfillCtx, backfillLegacyOriginals } from "./backfill-legacy"
import { sha256Hex } from "./backfill-sha256"

type Row = Record<string, unknown>

const DOC_A = "00000000-0000-4000-8000-00000000a001" // imported, still on its imported PDF
const DOC_B = "00000000-0000-4000-8000-00000000a002" // imported, its PDF replaced by a re-render
const DOC_C = "00000000-0000-4000-8000-00000000a003" // issued in the app, never imported

function bytesOf(seed: number, n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (seed * 7 + i * 13) & 0xff
  return out
}

interface StoredFile {
  bytes: Uint8Array
  filename: string
  entityType: string
  entityId: string
}

function world(opts: { sizes?: [number, number] } = {}) {
  const [sizeA, sizeB] = opts.sizes ?? [3000, 4000]
  const files = new Map<string, StoredFile>([
    ["file-a", { bytes: bytesOf(1, sizeA), filename: "1101.pdf", entityType: "pdf", entityId: "file-a" }],
    ["file-b", { bytes: bytesOf(2, sizeB), filename: "1102.pdf", entityType: "pdf", entityId: "file-b" }],
    ["render-b", { bytes: bytesOf(3, 900), filename: "invoice-1102.pdf", entityType: "pdf", entityId: "render-b" }],
  ])
  const base = {
    type: "invoice",
    status: "issued",
    issuer_profile_id: "iss-1",
    currency: "EUR",
    subtotal_minor: "10000",
    tax_total_minor: "0",
    grand_total_minor: "10000",
    issued_at: "2025-02-01",
    pdf_status: "ready",
    legal_original_id: null,
    lifecycle_log: [],
  }
  const db = createMockDb({
    seed: {
      documents: [
        { ...base, id: DOC_A, number: "1101", pdf_file_id: "file-a", external_refs: { import_source: "1101.pdf", import_file_id: "file-a" } },
        { ...base, id: DOC_B, number: "1102", pdf_file_id: "render-b", external_refs: { import_source: "1102.pdf", import_file_id: "file-b" } },
        { ...base, id: DOC_C, number: "INV-2026-1", pdf_file_id: "render-c", external_refs: {} },
      ],
    },
  })
  const reads: Array<Row> = []
  const imports: Array<Row> = []
  let copySeq = 0
  const toB64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
  const ctx: LegacyBackfillCtx = {
    db,
    getUserId: async () => "user-1",
    async files_getAttachmentBytes(argsJson: string) {
      const p = JSON.parse(argsJson) as { fileId: string; allowedParents: Array<Row> }
      reads.push(p)
      const f = files.get(p.fileId)
      if (!f) throw new Error("forbidden")
      const allowed = p.allowedParents.some(
        (a) => a.app === "invoicing" && a.entityType === f.entityType && a.entityId === f.entityId,
      )
      if (!allowed) throw new Error("forbidden")
      return JSON.stringify({ filename: f.filename, mimeType: "application/pdf", sizeBytes: f.bytes.length, bytesBase64: toB64(f.bytes) })
    },
    async files_importAttachment(argsJson: string) {
      const p = JSON.parse(argsJson) as Row
      imports.push(p)
      const id = `copy-${++copySeq}`
      const bytes = new Uint8Array(Buffer.from(String(p.bytesBase64), "base64"))
      files.set(id, { bytes, filename: String(p.filename), entityType: String(p.targetEntityType), entityId: String(p.targetEntityId) })
      return JSON.stringify({ id, sizeBytes: bytes.length })
    },
  }
  return { db, ctx, files, reads, imports }
}

const doc = (db: MockDb, id: string) => db.__all("documents").find((d) => d.id === id) as Row
const originals = (db: MockDb) => db.__all("legal_originals") as Row[]

describe("einvoicing_backfill_legacy_originals", () => {
  test("dry run (the default) reports the batch and the re-pointed documents, and writes nothing", async () => {
    const { db, ctx, reads, imports } = world()
    const r = await backfillLegacyOriginals(ctx, {})
    expect(r).toMatchObject({ status: "ok", dry_run: true, processed: 2, repointed: 1, remaining: 0, bytes: 0 })
    expect(originals(db)).toHaveLength(0)
    expect(doc(db, DOC_B).pdf_file_id).toBe("render-b")
    expect(reads).toHaveLength(0)
    expect(imports).toHaveLength(0)
  })

  test("the real run hashes each imported file, copies it onto its legal original and restores the re-pointed one", async () => {
    const { db, ctx, files, imports } = world()
    const r = await backfillLegacyOriginals(ctx, { dry_run: false })
    expect(r).toMatchObject({ status: "ok", dry_run: false, processed: 2, repointed: 1, remaining: 0, bytes: 7000 })

    const rows = originals(db)
    expect(rows).toHaveLength(2)
    for (const [docId, source] of [
      [DOC_A, "file-a"],
      [DOC_B, "file-b"],
    ] as const) {
      const row = rows.find((o) => o.document_id === docId)!
      const imported = files.get(source)!.bytes
      expect(row).toMatchObject({ kind: "legacy_import", sha256: sha256Hex(imported), byte_size: imported.length, recorded_by: "user-1" })
      // The copy lives on the legal original row, byte for byte the imported file.
      const copy = files.get(String(row.file_id))!
      expect(copy.entityType).toBe("legal_original")
      expect(copy.entityId).toBe(String(row.id))
      expect(sha256Hex(copy.bytes)).toBe(row.sha256 as string)
      const d = doc(db, docId)
      expect(d.legal_original_id).toBe(row.id)
      expect(d.legal_original_sha256).toBe(row.sha256)
      expect(d.pdf_file_id).toBe(source)
    }
    expect(imports.map((i) => i.targetApp)).toEqual(["invoicing", "invoicing"])

    const restored = (doc(db, DOC_B).lifecycle_log as Row[]).filter((e) => e.event === "legal_original_restored")
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ from_file_id: "render-b", to_file_id: "file-b" })
    expect((doc(db, DOC_A).lifecycle_log as Row[]).some((e) => e.event === "legal_original_restored")).toBe(false)
    // A document issued in the app is not a legacy import.
    expect(doc(db, DOC_C).legal_original_id ?? null).toBeNull()
    expect(doc(db, DOC_C).pdf_file_id).toBe("render-c")
  })

  test("a second run finds nothing left", async () => {
    const { ctx, imports } = world()
    await backfillLegacyOriginals(ctx, { dry_run: false })
    const again = await backfillLegacyOriginals(ctx, { dry_run: false })
    expect(again).toMatchObject({ processed: 0, repointed: 0, remaining: 0, bytes: 0 })
    expect(imports).toHaveLength(2)
  })

  test("a document a cut-off batch left half done (its row written, the document not pointed) is finished from that row", async () => {
    const { db, ctx, files, imports } = world()
    const sha = sha256Hex(files.get("file-a")!.bytes)
    // The earlier batch inserted the row and stopped before the copy and the document update.
    await db.insert("legal_originals", { document_id: DOC_A, kind: "legacy_import", file_id: null, sha256: sha, byte_size: 3000 })
    const r = await backfillLegacyOriginals(ctx, { dry_run: false })
    expect(r).toMatchObject({ status: "ok", processed: 2, remaining: 0 })
    const rowsA = originals(db).filter((o) => o.document_id === DOC_A)
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0]!.file_id).toBeTruthy()
    expect(doc(db, DOC_A).legal_original_id).toBe(rowsA[0]!.id)
    expect(doc(db, DOC_A).legal_original_sha256).toBe(sha)
    expect(imports).toHaveLength(2)
  })

  test("a half-done row whose copy already exists is reused without a second copy", async () => {
    const { db, ctx, files, imports } = world()
    const sha = sha256Hex(files.get("file-a")!.bytes)
    await db.insert("legal_originals", { document_id: DOC_A, kind: "legacy_import", file_id: "copy-earlier", sha256: sha, byte_size: 3000 })
    await backfillLegacyOriginals(ctx, { dry_run: false })
    expect(originals(db).filter((o) => o.document_id === DOC_A)).toHaveLength(1)
    expect(imports.filter((i) => i.targetEntityId === String(originals(db).find((o) => o.document_id === DOC_A)!.id))).toHaveLength(0)
    expect(doc(db, DOC_A).legal_original_id).toBeTruthy()
  })

  test("a recorded row with other bytes is a conflict: the document is set aside and nothing is overwritten", async () => {
    const { db, ctx } = world()
    await db.insert("legal_originals", { document_id: DOC_A, kind: "legacy_import", file_id: "x", sha256: "f".repeat(64), byte_size: 1 })
    const r = await backfillLegacyOriginals(ctx, { dry_run: false })
    expect((r.failed as Row[]).map((f) => f.document_id)).toEqual([DOC_A])
    expect(String((r.failed as Row[])[0]!.error)).toContain("legal_original_conflict")
    expect(originals(db).filter((o) => o.document_id === DOC_A)).toHaveLength(1)
    expect(doc(db, DOC_A).legal_original_id ?? null).toBeNull()
    expect(doc(db, DOC_A).pdf_file_id).toBe("file-a")
  })

  test("a batch stops before max_bytes and reports what remains", async () => {
    const { db, ctx } = world({ sizes: [3000, 4000] })
    const first = await backfillLegacyOriginals(ctx, { dry_run: false, max_bytes: 5000 })
    expect(first).toMatchObject({ processed: 1, remaining: 1, bytes: 3000 })
    expect(originals(db)).toHaveLength(1)
    // The document left for the next batch keeps its current PDF until that batch restores it.
    expect(doc(db, DOC_B).pdf_file_id).toBe("render-b")
    const second = await backfillLegacyOriginals(ctx, { dry_run: false, max_bytes: 5000 })
    expect(second).toMatchObject({ processed: 1, repointed: 1, remaining: 0, bytes: 4000 })
    expect(doc(db, DOC_B).pdf_file_id).toBe("file-b")
  })

  test("one file larger than max_bytes is still processed alone, so a batch always progresses", async () => {
    const { ctx } = world({ sizes: [6000, 4000] })
    const r = await backfillLegacyOriginals(ctx, { dry_run: false, max_bytes: 5000 })
    expect(r).toMatchObject({ processed: 1, remaining: 1, bytes: 6000 })
  })

  test("limit bounds the batch", async () => {
    const { ctx } = world()
    const r = await backfillLegacyOriginals(ctx, { dry_run: false, limit: 1 })
    expect(r).toMatchObject({ processed: 1, remaining: 1 })
  })

  test("an imported file that cannot be read is reported, and its document keeps the PDF it had", async () => {
    const { db, ctx, files } = world()
    files.delete("file-b")
    const r = await backfillLegacyOriginals(ctx, { dry_run: false })
    // A failed document is set aside (not counted in `remaining`) so later batches move on.
    expect(r).toMatchObject({ processed: 1, repointed: 0, remaining: 0, set_aside: 1 })
    expect((r.failed as Row[]).map((f) => f.document_id)).toEqual([DOC_B])
    expect(doc(db, DOC_B).pdf_file_id).toBe("render-b")
    expect(originals(db).map((o) => o.document_id)).toEqual([DOC_A])
  })

  test("failed documents at the front never block later batches; retry_failed picks them up again", async () => {
    const { db, ctx, files } = world()
    // `limit` imported documents whose files cannot be read, sorting before every readable one.
    const bad = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]
    db.__seed(
      "documents",
      bad.map((id, i) => ({
        ...doc(db, DOC_A),
        id,
        number: `90${i}`,
        pdf_file_id: `gone-${i}`,
        external_refs: { import_source: `90${i}.pdf`, import_file_id: `gone-${i}` },
      })),
    )
    const first = await backfillLegacyOriginals(ctx, { dry_run: false, limit: 2 })
    expect(first).toMatchObject({ processed: 0, remaining: 2, set_aside: 2 })
    expect((first.failed as Row[]).map((f) => f.document_id)).toEqual(bad)
    // The failure is recorded on the document, against the file that could not be read.
    const marker = (doc(db, bad[0] as string).external_refs as Row).legal_original_backfill_failure as Row
    expect(marker).toMatchObject({ file_id: "gone-0" })
    expect(typeof marker.error).toBe("string")
    expect((doc(db, bad[0] as string).external_refs as Row).import_source).toBe("900.pdf")

    const second = await backfillLegacyOriginals(ctx, { dry_run: false, limit: 2 })
    expect(second).toMatchObject({ processed: 2, remaining: 0, set_aside: 2 })
    expect(originals(db).map((o) => o.document_id).sort()).toEqual([DOC_A, DOC_B])

    // The dry run reports the set-aside documents too.
    expect(await backfillLegacyOriginals(ctx, {})).toMatchObject({ processed: 0, remaining: 0, set_aside: 2 })

    // Once the file is readable again, retry_failed records it and clears the marker.
    files.set("gone-0", { bytes: bytesOf(9, 500), filename: "900.pdf", entityType: "pdf", entityId: "gone-0" })
    const retry = await backfillLegacyOriginals(ctx, { dry_run: false, retry_failed: true })
    expect(retry).toMatchObject({ processed: 1, set_aside: 1 })
    expect((retry.failed as Row[]).map((f) => f.document_id)).toEqual([bad[1]])
    expect((doc(db, bad[0] as string).external_refs as Row).legal_original_backfill_failure).toBeUndefined()
    expect(doc(db, bad[0] as string).legal_original_id).toBeTruthy()
  })

  test("a marker recorded against another file does not set the document aside", async () => {
    const { db, ctx } = world()
    const a = doc(db, DOC_A)
    await db.update("documents", DOC_A, {
      external_refs: { ...(a.external_refs as Row), legal_original_backfill_failure: { file_id: "older-file", error: "x" } },
    })
    const r = await backfillLegacyOriginals(ctx, { dry_run: false })
    expect(r).toMatchObject({ processed: 2, remaining: 0, set_aside: 0 })
  })

  test("parameters are clamped: limit at most 50, max_bytes at most 10 MB", async () => {
    const { ctx } = world()
    const r = await backfillLegacyOriginals(ctx, { limit: 500, max_bytes: 999_000_000 })
    expect(r).toMatchObject({ limit: 50, max_bytes: 10_000_000 })
  })
})
