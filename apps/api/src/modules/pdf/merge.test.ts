// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Behavioural test for the host-side PDF merge. Hits a real Postgres (RLS) and
 * the real object store: source PDFs are generated with pdf-lib, stored as
 * kernel.files rows parented to a thread the caller participates in, then merged
 * through the real `mergePdfs`. Order + repeat semantics, non-PDF and unknown-id
 * rejection, cross-org isolation, and the size/page caps are all asserted
 * against the real merged output bytes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { degrees, PDFDocument } from "pdf-lib"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { files } from "~/db/schema/kernel/files"
import { getObjectBuffer, putObject } from "~/infra/storage/object-storage"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedTwoOrgsWithIsolatedData } from "~/tests/security/seeds"
import { MERGE_MAX_OUTPUT_PAGES, MergePdfsError, mergePdfs, normalizeMergedTitle } from "./merge"

/** Build a real single-or-multi-page PDF whose first page carries `label`. */
async function makePdfBytes(label: string, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([200, 200])
    page.drawText(`${label} p${i}`, { x: 10, y: 100, size: 12 })
  }
  return doc.save()
}

/** Seed one stored PDF file parented to a thread the user owns. Returns file id. */
async function seedPdfFile(
  orgId: string,
  userId: string,
  threadId: string,
  label: string,
  bytes: Uint8Array,
): Promise<string> {
  const storageKey = `orgs/${orgId}/k/thread/${threadId}/${crypto.randomUUID()}/${label}.pdf`
  await putObject({ key: storageKey, body: Buffer.from(bytes), contentType: "application/pdf" })
  return withPrivilegedDb(orgId, "merge-test-seed-file", async (tx) => {
    const [f] = await tx
      .insert(files)
      .values({
        orgId,
        app: "kernel",
        entityType: "thread",
        entityId: threadId,
        filename: `${label}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: bytes.byteLength,
        storageKey,
        uploadedBy: userId,
      })
      .returning({ id: files.id })
    return f.id
  })
}

async function seedNonPdfFile(orgId: string, userId: string, threadId: string): Promise<string> {
  const storageKey = `orgs/${orgId}/k/thread/${threadId}/${crypto.randomUUID()}/notes.txt`
  await putObject({
    key: storageKey,
    body: Buffer.from("hello, not a pdf"),
    contentType: "text/plain",
  })
  return withPrivilegedDb(orgId, "merge-test-seed-txt", async (tx) => {
    const [f] = await tx
      .insert(files)
      .values({
        orgId,
        app: "kernel",
        entityType: "thread",
        entityId: threadId,
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 16,
        storageKey,
        uploadedBy: userId,
      })
      .returning({ id: files.id })
    return f.id
  })
}

async function createThread(orgId: string, userId: string): Promise<string> {
  return withPrivilegedDb(orgId, "merge-test-thread", async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({
        orgId,
        handle: `merge-${crypto.randomUUID().slice(0, 8)}`,
        title: "Merge Thread",
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: threads.id })
    await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId, role: "owner" })
    return t.id
  })
}

function rlsCtx(orgId: string, userId: string) {
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: ["kernel:files:read", "kernel:threads:write"],
    dimensionGrants: {},
  }
}

let orgA: string
let userA: string
let threadA: string
let orgB: string
let userB: string
let threadB: string

beforeAll(async () => {
  await acquireTestLock()
  // Two isolated orgs in ONE bootstrap (createTestOrg truncates, so it cannot
  // be called twice) — gives us a cross-org file for the isolation test.
  const fx = await seedTwoOrgsWithIsolatedData()
  orgA = fx.orgA.id
  userA = fx.userA.id
  orgB = fx.orgB.id
  userB = fx.userB.id
  threadA = await createThread(orgA, userA)
  threadB = await createThread(orgB, userB)
  // Threads-as-parent visibility: the boot policy is USING(false) until rebuilt.
  const { rebuildFilesSelectPolicy } = await import("~/infra/boot-phase10")
  await rebuildFilesSelectPolicy()
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("normalizeMergedTitle", () => {
  it("defaults to merged.pdf and always ends in .pdf", () => {
    expect(normalizeMergedTitle(undefined)).toBe("merged.pdf")
    expect(normalizeMergedTitle("")).toBe("merged.pdf")
    expect(normalizeMergedTitle("  ")).toBe("merged.pdf")
    expect(normalizeMergedTitle("packet")).toBe("packet.pdf")
    expect(normalizeMergedTitle("packet.pdf")).toBe("packet.pdf")
    expect(normalizeMergedTitle("packet.PDF")).toBe("packet.PDF")
  })
})

describe("mergePdfs", () => {
  it("refuses past the org's storage cap and stores no merged file", async () => {
    const idA = await seedPdfFile(orgA, userA, threadA, "capA", await makePdfBytes("A", 1))
    const idB = await seedPdfFile(orgA, userA, threadA, "capB", await makePdfBytes("B", 1))
    // The org at a 1 GB cap, already holding 1 GB.
    const padId = await withPrivilegedDb(orgA, "merge-test-cap", async (tx) => {
      const [prev] = extractRows<{ caps: unknown }>(
        await tx.execute(drizzleSql`SELECT caps FROM kernel.organizations WHERE id = ${orgA}`),
      )
      await tx.execute(
        drizzleSql`UPDATE kernel.organizations SET caps = ${JSON.stringify({ storageGb: 1 })}::jsonb WHERE id = ${orgA}`,
      )
      const [pad] = await tx
        .insert(files)
        .values({
          orgId: orgA,
          app: "kernel",
          entityType: "cap_pad",
          entityId: crypto.randomUUID(),
          filename: "pad.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 1024 ** 3,
          storageKey: `orgs/${orgA}/cap-pad/${crypto.randomUUID()}`,
        })
        .returning({ id: files.id })
      return { id: pad.id, caps: prev?.caps ?? {} }
    })
    const stored = async () =>
      extractRows<{ n: number }>(
        await withPrivilegedDb(orgA, "merge-test-count", (tx) =>
          tx.execute(
            drizzleSql`SELECT count(*)::int AS n FROM kernel.files WHERE org_id = ${orgA} AND entity_type = 'file_upload_session'`,
          ),
        ),
      )[0]?.n
    const before = await stored()
    try {
      const err = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
        mergePdfs({ fileIds: [idA, idB] }, { rlsTx: tx, orgId: orgA, userId: userA }),
      ).catch((e) => e)
      expect(err).toBeInstanceOf(MergePdfsError)
      expect((err as MergePdfsError).code).toBe("storage_quota_exceeded")
      expect(await stored()).toBe(before)
    } finally {
      await withPrivilegedDb(orgA, "merge-test-cap-undo", async (tx) => {
        await tx.execute(drizzleSql`DELETE FROM kernel.files WHERE id = ${padId.id}`)
        await tx.execute(
          drizzleSql`UPDATE kernel.organizations SET caps = ${JSON.stringify(padId.caps)}::jsonb WHERE id = ${orgA}`,
        )
      })
    }
  })

  it("merges two PDFs in order and stores a new attachable kernel file", async () => {
    const idA = await seedPdfFile(orgA, userA, threadA, "invoice", await makePdfBytes("A", 2))
    const idB = await seedPdfFile(orgA, userA, threadA, "label", await makePdfBytes("B", 1))

    const res = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      mergePdfs(
        { fileIds: [idA, idB], title: "packet" },
        { rlsTx: tx, orgId: orgA, userId: userA },
      ),
    )

    expect(res.title).toBe("packet.pdf")
    expect(res.page_count).toBe(3)
    expect(res.byte_size).toBeGreaterThan(100)

    // The merged bytes really contain 3 pages, and the stored row is readable
    // back under the OWNER's RLS context (staged in a caller-owned session) —
    // i.e. downloadable via files_read / attachable to a reply.
    const [row] = extractRows<{ storage_key: string; entity_type: string }>(
      await withPrivilegedDb(orgA, "merge-test-read", async (tx) =>
        tx.execute(
          drizzleSql`SELECT storage_key, entity_type FROM kernel.files WHERE id = ${res.file_id}::uuid`,
        ),
      ),
    )
    expect(row.entity_type).toBe("file_upload_session")
    const merged = await PDFDocument.load(await getObjectBuffer(row.storage_key))
    expect(merged.getPageCount()).toBe(3)

    const visible = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      tx.execute<{ id: string }>(
        drizzleSql`SELECT id::text AS id FROM kernel.files WHERE id = ${res.file_id}::uuid`,
      ),
    )
    expect(extractRows(visible)).toHaveLength(1)
  })

  it("preserves order AND repeats: [A,A,B] yields 2xA-pages then B", async () => {
    // A = 2 pages, B = 1 page. [A, A, B] -> 2 + 2 + 1 = 5 pages.
    const idA = await seedPdfFile(orgA, userA, threadA, "dup-invoice", await makePdfBytes("A", 2))
    const idB = await seedPdfFile(orgA, userA, threadA, "dup-label", await makePdfBytes("B", 1))

    const res = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      mergePdfs({ fileIds: [idA, idA, idB] }, { rlsTx: tx, orgId: orgA, userId: userA }),
    )
    expect(res.page_count).toBe(5)
    expect(res.title).toBe("merged.pdf")

    const [row] = extractRows<{ storage_key: string }>(
      await withPrivilegedDb(orgA, "merge-test-read2", async (tx) =>
        tx.execute(
          drizzleSql`SELECT storage_key FROM kernel.files WHERE id = ${res.file_id}::uuid`,
        ),
      ),
    )
    const merged = await PDFDocument.load(await getObjectBuffer(row.storage_key))
    expect(merged.getPageCount()).toBe(5)
  })

  it("rejects a non-PDF input naming the offending id", async () => {
    const idPdf = await seedPdfFile(orgA, userA, threadA, "ok", await makePdfBytes("A", 1))
    const idTxt = await seedNonPdfFile(orgA, userA, threadA)

    const err = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      mergePdfs({ fileIds: [idPdf, idTxt] }, { rlsTx: tx, orgId: orgA, userId: userA }).then(
        () => null,
        (e) => e,
      ),
    )
    expect(err).toBeInstanceOf(MergePdfsError)
    expect((err as MergePdfsError).code).toBe("not_a_pdf")
    expect((err as MergePdfsError).message).toContain(idTxt)
  })

  it("rejects an unknown file id", async () => {
    const idPdf = await seedPdfFile(orgA, userA, threadA, "known", await makePdfBytes("A", 1))
    const bogus = crypto.randomUUID()
    const err = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      mergePdfs({ fileIds: [idPdf, bogus] }, { rlsTx: tx, orgId: orgA, userId: userA }).then(
        () => null,
        (e) => e,
      ),
    )
    expect(err).toBeInstanceOf(MergePdfsError)
    expect((err as MergePdfsError).code).toBe("file_not_found")
    expect((err as MergePdfsError).message).toContain(bogus)
  })

  it("rejects a cross-org file id (invisible under the caller's RLS)", async () => {
    const idA = await seedPdfFile(orgA, userA, threadA, "mine", await makePdfBytes("A", 1))
    const idOther = await seedPdfFile(orgB, userB, threadB, "theirs", await makePdfBytes("B", 1))

    // User A cannot see org B's file — it resolves as not-found, never merged.
    const err = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      mergePdfs({ fileIds: [idA, idOther] }, { rlsTx: tx, orgId: orgA, userId: userA }).then(
        () => null,
        (e) => e,
      ),
    )
    expect(err).toBeInstanceOf(MergePdfsError)
    expect((err as MergePdfsError).code).toBe("file_not_found")
    expect((err as MergePdfsError).message).toContain(idOther)
  })

  it("accepts a UNARY merge (single file) — the orientation-normalization path — and rejects zero files", async () => {
    const idA = await seedPdfFile(orgA, userA, threadA, "solo", await makePdfBytes("A", 1))
    const res = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      mergePdfs({ fileIds: [idA] }, { rlsTx: tx, orgId: orgA, userId: userA }),
    )
    expect(res.page_count).toBe(1)
    const err = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      mergePdfs({ fileIds: [] }, { rlsTx: tx, orgId: orgA, userId: userA }).then(
        () => null,
        (e) => e,
      ),
    )
    expect(err).toBeInstanceOf(MergePdfsError)
    expect((err as MergePdfsError).code).toBe("too_few_files")
  })

  it("size cap is a typed error when the summed input exceeds 50 MB", async () => {
    // Prove the cap branch with a stubbed row set (no 50 MB of real bytes):
    // an rlsTx that returns oversized size_bytes for the requested ids.
    const bigId1 = crypto.randomUUID()
    const bigId2 = crypto.randomUUID()
    const fakeRls = {
      execute: async () => [
        {
          id: bigId1,
          filename: "big1.pdf",
          mimeType: "application/pdf",
          sizeBytes: 30 * 1024 * 1024,
          storageKey: "k1",
        },
        {
          id: bigId2,
          filename: "big2.pdf",
          mimeType: "application/pdf",
          sizeBytes: 30 * 1024 * 1024,
          storageKey: "k2",
        },
      ],
    } as never
    const err = await mergePdfs(
      { fileIds: [bigId1, bigId2] },
      { rlsTx: fakeRls, orgId: orgA, userId: userA },
    ).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(MergePdfsError)
    expect((err as MergePdfsError).code).toBe("input_too_large")
  })

  it("enforces the output page cap with a typed error", async () => {
    // Two files whose combined page count exceeds MERGE_MAX_OUTPUT_PAGES.
    const half = Math.ceil((MERGE_MAX_OUTPUT_PAGES + 2) / 2)
    const idA = await seedPdfFile(orgA, userA, threadA, "many1", await makePdfBytes("A", half))
    const idB = await seedPdfFile(orgA, userA, threadA, "many2", await makePdfBytes("B", half))
    const err = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      mergePdfs({ fileIds: [idA, idB] }, { rlsTx: tx, orgId: orgA, userId: userA }).then(
        () => null,
        (e) => e,
      ),
    )
    expect(err).toBeInstanceOf(MergePdfsError)
    expect((err as MergePdfsError).code).toBe("too_many_pages")
  })
})

describe("mergePdfs — page /Rotate baking (sideways-label print fix)", () => {
  it("bakes a source page's rotation into the content: output pages carry no /Rotate and swapped dims", async () => {
    // A landscape-letter page (792x612) with /Rotate 270 — the Boxtal label shape.
    const rotatedDoc = await PDFDocument.create()
    const rp = rotatedDoc.addPage([792, 612])
    rp.drawText("LABEL", { x: 40, y: 40 })
    rp.setRotation(degrees(270))
    const rotatedBytes = await rotatedDoc.save({ useObjectStreams: false })
    const idPlain = await seedPdfFile(orgA, userA, threadA, "plain", await makePdfBytes("P", 1))
    const idRot = await seedPdfFile(orgA, userA, threadA, "rot", rotatedBytes)
    const res = await withRlsContext(rlsCtx(orgA, userA), (tx) =>
      mergePdfs({ fileIds: [idPlain, idRot] }, { rlsTx: tx, orgId: orgA, userId: userA }),
    )
    const [row] = extractRows<{ storage_key: string }>(
      await withPrivilegedDb(orgA, "merge-rotate-read", async (tx) =>
        tx.execute(
          drizzleSql`SELECT storage_key FROM kernel.files WHERE id = ${res.file_id}::uuid`,
        ),
      ),
    )
    const merged = await PDFDocument.load(await getObjectBuffer(row.storage_key))
    expect(merged.getPageCount()).toBe(2)
    const p2 = merged.getPage(1)
    expect(((p2.getRotation().angle % 360) + 360) % 360).toBe(0)
    // Dimensions swapped by the bake: 792x612 rotated becomes 612x792.
    expect(Math.round(p2.getWidth())).toBe(612)
    expect(Math.round(p2.getHeight())).toBe(792)
  })
})
