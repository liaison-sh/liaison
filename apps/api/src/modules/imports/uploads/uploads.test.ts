// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import uploads against real Postgres and the dev object store (SeaweedFS):
 * a three-part multipart upload completed into a kernel.files row, resume
 * from ListParts after a dropped part, the reaper, the import cap, relay
 * mode, ownership, and the CORS answer a browser needs to read part ETags.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { importUploads } from "~/db/schema/kernel"
import { listUploadedParts, multipartPartCount, multipartPartSize } from "~/infra/storage/multipart"
import { deleteObject, headObject, putObject } from "~/infra/storage/object-storage"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  abortImportUpload,
  completeImportUpload,
  createImportUpload,
  getImportUpload,
  type ImportUploadDeps,
  ImportUploadError,
  reapExpiredImportUploads,
  signImportUploadParts,
} from "./service"

const MIB = 1024 * 1024
let orgId: string
let aliceId: string
let bobId: string
const keys: string[] = []

async function asUser<T>(
  userId: string,
  fn: (deps: ImportUploadDeps) => Promise<T>,
  delivery: "direct" | "relay" = "direct",
): Promise<T> {
  return withRlsContext(
    { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} },
    (rlsTx) =>
      fn({ rlsTx, privileged: (reason, f) => withPrivilegedDb(orgId, reason, f), delivery }),
  )
}

async function errorOf(p: Promise<unknown>): Promise<ImportUploadError> {
  try {
    await p
  } catch (err) {
    if (err instanceof ImportUploadError) return err
    throw err
  }
  throw new Error("expected an ImportUploadError")
}

function partBody(n: number, bytes: number): Uint8Array {
  return new Uint8Array(bytes).fill(64 + n)
}

async function putPart(url: string, body: Uint8Array): Promise<Response> {
  const res = await fetch(url, {
    method: "PUT",
    body,
    headers: { Origin: "http://localhost:5173" },
  })
  expect(res.status).toBe(200)
  return res
}

beforeAll(async () => {
  await acquireTestLock()
  const stamp = Date.now()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Import Uploads Org', ${`import-uploads-${stamp}`}) RETURNING id
    `),
  )
  orgId = org!.id
  for (const [name, set] of [
    ["alice", (id: string) => (aliceId = id)],
    ["bob", (id: string) => (bobId = id)],
  ] as const) {
    const [u] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${name}-iu-${stamp}@example.test`}, ${name}, 'active', 'h', 1, 1)
        RETURNING id
      `),
    )
    set(u!.id)
  }
})

afterAll(async () => {
  for (const key of keys) await deleteObject(key).catch(() => undefined)
  await releaseTestLock()
})

describe("part size", () => {
  it("is max(8 MiB, size / 9,000) rounded up to a MiB", () => {
    expect(multipartPartSize(10 * MIB)).toBe(8 * MIB)
    expect(multipartPartSize(5 * 1024 * MIB)).toBe(8 * MIB)
    expect(multipartPartSize(100 * 1024 * MIB)).toBe(12 * MIB)
    expect(multipartPartCount(5 * 1024 * MIB, 8 * MIB)).toBe(640)
  })
})

describe("multipart import upload", () => {
  it("create → three parts → complete → a kernel.files row the uploader owns", async () => {
    const size = 2 * 8 * MIB + 4096
    const created = await asUser(aliceId, (deps) =>
      createImportUpload(
        { orgId, userId: aliceId, filename: "export.zip", mimeType: "application/zip", size },
        deps,
      ),
    )
    expect(created).toMatchObject({
      mode: "multipart",
      status: "uploading",
      partSize: 8 * MIB,
      partCount: 3,
    })
    expect(created.parts?.map((p) => p.partNumber)).toEqual([1, 2, 3])
    const [row] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    keys.push(row!.storageKey)

    for (const p of created.parts ?? []) {
      const bytes = p.partNumber < 3 ? 8 * MIB : 4096
      const res = await putPart(p.url, partBody(p.partNumber, bytes))
      // The browser path: the store exposes the part's ETag to a cross-origin page.
      expect(res.headers.get("etag")).toBeTruthy()
      expect((res.headers.get("access-control-expose-headers") ?? "").toLowerCase()).toContain(
        "etag",
      )
    }

    const done = await asUser(aliceId, (deps) =>
      completeImportUpload({ orgId, userId: aliceId, id: created.id }, deps),
    )
    expect(done.status).toBe("complete")
    expect(done.fileId).toBeTruthy()
    const [file] = extractRows<{
      size_bytes: number
      mime_type: string
      entity_type: string
      uploaded_by: string
    }>(
      await db.execute(
        drizzleSql`SELECT size_bytes, mime_type, entity_type, uploaded_by FROM kernel.files WHERE id = ${done.fileId}::uuid`,
      ),
    )
    expect(Number(file!.size_bytes)).toBe(size)
    expect(file).toMatchObject({
      mime_type: "application/zip",
      entity_type: "file_upload_session",
      uploaded_by: aliceId,
    })
    expect((await headObject(row!.storageKey)).contentLength).toBe(size)

    // Completing again is idempotent.
    const again = await asUser(aliceId, (deps) =>
      completeImportUpload({ orgId, userId: aliceId, id: created.id }, deps),
    )
    expect(again.fileId).toBe(done.fileId)
  }, 120_000)

  it("resumes from ListParts after a dropped part", async () => {
    const size = 2 * 8 * MIB + 100
    const created = await asUser(aliceId, (deps) =>
      createImportUpload(
        { orgId, userId: aliceId, filename: "tickets.csv", mimeType: "text/csv", size },
        deps,
      ),
    )
    const [row] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    keys.push(row!.storageKey)
    const urls = new Map((created.parts ?? []).map((p) => [p.partNumber, p.url]))
    await putPart(urls.get(1)!, partBody(1, 8 * MIB))
    // Part 2 is "dropped" (never sent); part 3 arrives.
    await putPart(urls.get(3)!, partBody(3, 100))

    const state = await asUser(aliceId, (deps) =>
      getImportUpload({ orgId, userId: aliceId, id: created.id }, deps),
    )
    expect(state.received.map((p) => p.partNumber)).toEqual([1, 3])
    expect(state.missing).toEqual([2])

    const early = await errorOf(
      asUser(aliceId, (deps) =>
        completeImportUpload({ orgId, userId: aliceId, id: created.id }, deps),
      ),
    )
    expect(early.code).toBe("PARTS_MISSING")
    expect(early.message).toContain("2")

    const [fresh] = await asUser(aliceId, (deps) =>
      signImportUploadParts({ orgId, userId: aliceId, id: created.id, partNumbers: [2] }, deps),
    )
    await putPart(fresh!.url, partBody(2, 8 * MIB))
    const done = await asUser(aliceId, (deps) =>
      completeImportUpload({ orgId, userId: aliceId, id: created.id }, deps),
    )
    expect(done.status).toBe("complete")
  }, 120_000)

  it("another user cannot see, sign, complete or abort it", async () => {
    const created = await asUser(aliceId, (deps) =>
      createImportUpload(
        { orgId, userId: aliceId, filename: "a.json", mimeType: "application/json", size: 10 },
        deps,
      ),
    )
    const [row] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    keys.push(row!.storageKey)
    const calls: Array<(d: ImportUploadDeps) => Promise<unknown>> = [
      (d: ImportUploadDeps) => getImportUpload({ orgId, userId: bobId, id: created.id }, d),
      (d: ImportUploadDeps) =>
        signImportUploadParts({ orgId, userId: bobId, id: created.id, partNumbers: [1] }, d),
      (d: ImportUploadDeps) => completeImportUpload({ orgId, userId: bobId, id: created.id }, d),
      (d: ImportUploadDeps) => abortImportUpload({ orgId, userId: bobId, id: created.id }, d),
    ]
    for (const call of calls) {
      expect((await errorOf(asUser(bobId, call))).code).toBe("NOT_FOUND")
    }
    await asUser(aliceId, (deps) =>
      abortImportUpload({ orgId, userId: aliceId, id: created.id }, deps),
    )
  })

  it("the reaper aborts uploads left open past their expiry", async () => {
    const created = await asUser(aliceId, (deps) =>
      createImportUpload(
        { orgId, userId: aliceId, filename: "old.zip", mimeType: "application/zip", size: 9 * MIB },
        deps,
      ),
    )
    const [row] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    keys.push(row!.storageKey)
    await putPart(created.parts![0]!.url, partBody(1, 8 * MIB))
    await db
      .update(importUploads)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(importUploads.id, created.id))

    const pass = await reapExpiredImportUploads()
    expect(pass.aborted).toBeGreaterThanOrEqual(1)
    const [after] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    expect(after!.status).toBe("aborted")
    // The store no longer holds the upload.
    await expect(
      listUploadedParts({ key: row!.storageKey, uploadId: row!.uploadId! }),
    ).rejects.toThrow()
  }, 60_000)
})

describe("limits and relay mode", () => {
  it("refuses a file over the org's import cap, naming the setting", async () => {
    await db.execute(
      drizzleSql`UPDATE kernel.organizations SET settings = settings || '{"importFileSizeLimitMb": 1}'::jsonb WHERE id = ${orgId}::uuid`,
    )
    try {
      const err = await errorOf(
        asUser(aliceId, (deps) =>
          createImportUpload(
            {
              orgId,
              userId: aliceId,
              filename: "big.zip",
              mimeType: "application/zip",
              size: 2 * MIB,
            },
            deps,
          ),
        ),
      )
      expect(err.code).toBe("IMPORT_FILE_TOO_LARGE")
      expect(err.status).toBe(413)
      expect(err.message).toContain("importFileSizeLimitMb")
    } finally {
      await db.execute(
        drizzleSql`UPDATE kernel.organizations SET settings = settings - 'importFileSizeLimitMb' WHERE id = ${orgId}::uuid`,
      )
    }
  })

  it("relay mode refuses a file over fileSizeLimitMb with a message naming it", async () => {
    const err = await errorOf(
      asUser(
        aliceId,
        (deps) =>
          createImportUpload(
            {
              orgId,
              userId: aliceId,
              filename: "big.zip",
              mimeType: "application/zip",
              size: 60 * MIB,
            },
            deps,
          ),
        "relay",
      ),
    )
    expect(err.code).toBe("RELAY_FILE_TOO_LARGE")
    expect(err.message).toContain("fileSizeLimitMb (50 MB)")
    expect(err.message).toContain("OBJECT_STORAGE_BROWSER_DIRECT")
  })

  it("relay mode takes a smaller file through the relay PUT and completes it", async () => {
    const body = new TextEncoder().encode("id,subject\n1,Hello\n")
    const created = await asUser(
      aliceId,
      (deps) =>
        createImportUpload(
          {
            orgId,
            userId: aliceId,
            filename: "small.csv",
            mimeType: "text/csv",
            size: body.byteLength,
          },
          deps,
        ),
      "relay",
    )
    expect(created.mode).toBe("relay")
    expect(created.uploadUrl).toContain("/api/file-relay/")
    const [row] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    keys.push(row!.storageKey)
    // What the relay route writes.
    await putObject({ key: row!.storageKey, body, contentType: "text/csv" })
    const done = await asUser(
      aliceId,
      (deps) => completeImportUpload({ orgId, userId: aliceId, id: created.id }, deps),
      "relay",
    )
    expect(done.status).toBe("complete")
    expect(done.fileId).toBeTruthy()
  })
})

describe("part URLs and the quota are bound to the declared size", () => {
  it("a part URL refuses a body of another length; the last part is signed for its remainder", async () => {
    const size = 8 * MIB + 1000
    const created = await asUser(aliceId, (deps) =>
      createImportUpload(
        {
          orgId,
          userId: aliceId,
          filename: "bound.bin",
          mimeType: "application/octet-stream",
          size,
        },
        deps,
      ),
    )
    const [row] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    keys.push(row!.storageKey)
    const [p1, p2] = created.parts ?? []
    const wrong = await fetch(p1!.url, { method: "PUT", body: partBody(1, 8 * MIB + 5) })
    expect(wrong.status).not.toBe(200)
    const wrongLast = await fetch(p2!.url, { method: "PUT", body: partBody(2, 8 * MIB) })
    expect(wrongLast.status).not.toBe(200)
    await putPart(p1!.url, partBody(1, 8 * MIB))
    await putPart(p2!.url, partBody(2, 1000))
    const done = await asUser(aliceId, (deps) =>
      completeImportUpload({ orgId, userId: aliceId, id: created.id }, deps),
    )
    expect(done.status).toBe("complete")
  }, 120_000)

  it("open uploads reserve their declared size against the storage quota", async () => {
    await db.execute(
      drizzleSql`UPDATE kernel.organizations SET caps = caps || '{"storageGb": 1}'::jsonb WHERE id = ${orgId}::uuid`,
    )
    const opened: string[] = []
    try {
      const first = await asUser(aliceId, (deps) =>
        createImportUpload(
          {
            orgId,
            userId: aliceId,
            filename: "q1.zip",
            mimeType: "application/zip",
            size: 600 * MIB,
          },
          deps,
        ),
      )
      opened.push(first.id)
      const err = await errorOf(
        asUser(aliceId, (deps) =>
          createImportUpload(
            {
              orgId,
              userId: aliceId,
              filename: "q2.zip",
              mimeType: "application/zip",
              size: 600 * MIB,
            },
            deps,
          ),
        ),
      )
      expect(err.code).toBe("STORAGE_QUOTA_EXCEEDED")
      // The same status the files route answers for the same code.
      expect(err.status).toBe(409)
    } finally {
      for (const id of opened) {
        await asUser(aliceId, (deps) => abortImportUpload({ orgId, userId: aliceId, id }, deps))
      }
      await db.execute(
        drizzleSql`UPDATE kernel.organizations SET caps = caps - 'storageGb' WHERE id = ${orgId}::uuid`,
      )
    }
  }, 60_000)

  it("two concurrent creates cannot both take the last of the quota", async () => {
    await db.execute(
      drizzleSql`UPDATE kernel.organizations SET caps = caps || '{"storageGb": 1}'::jsonb WHERE id = ${orgId}::uuid`,
    )
    const results: Array<{ id?: string; code?: string }> = []
    try {
      // Each create waits (up to 1 s) after its quota check for the other to
      // check too: without a lock both would see the quota free.
      let checked = 0
      const barrier = async () => {
        checked++
        const until = Date.now() + 1000
        while (checked < 2 && Date.now() < until) await Bun.sleep(10)
      }
      const attempt = (name: string) =>
        asUser(aliceId, (deps) =>
          createImportUpload(
            {
              orgId,
              userId: aliceId,
              filename: name,
              mimeType: "application/zip",
              size: 600 * MIB,
            },
            { ...deps, afterQuotaCheck: barrier },
          ),
        ).then(
          (r) => ({ id: r.id }),
          (err: unknown) => ({ code: err instanceof ImportUploadError ? err.code : String(err) }),
        )
      results.push(...(await Promise.all([attempt("c1.zip"), attempt("c2.zip")])))
      expect(results.filter((r) => r.id).length).toBe(1)
      expect(results.filter((r) => r.code === "STORAGE_QUOTA_EXCEEDED").length).toBe(1)
    } finally {
      for (const r of results) {
        if (r.id) {
          const id = r.id
          await asUser(aliceId, (deps) => abortImportUpload({ orgId, userId: aliceId, id }, deps))
        }
      }
      await db.execute(
        drizzleSql`UPDATE kernel.organizations SET caps = caps - 'storageGb' WHERE id = ${orgId}::uuid`,
      )
    }
  }, 60_000)

  it("signing parts extends the upload's expiry", async () => {
    const created = await asUser(aliceId, (deps) =>
      createImportUpload(
        { orgId, userId: aliceId, filename: "slow.zip", mimeType: "application/zip", size: 10 },
        deps,
      ),
    )
    const [row] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    keys.push(row!.storageKey)
    await db
      .update(importUploads)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(importUploads.id, created.id))
    await asUser(aliceId, (deps) =>
      signImportUploadParts({ orgId, userId: aliceId, id: created.id, partNumbers: [1] }, deps),
    )
    const [after] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    expect(after!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000)
    await asUser(aliceId, (deps) =>
      abortImportUpload({ orgId, userId: aliceId, id: created.id }, deps),
    )
  })
})
