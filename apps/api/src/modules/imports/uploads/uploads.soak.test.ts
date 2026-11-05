// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SOAK (skipped unless LIAISON_SOAK=1; a few minutes and 2 GiB of free
// temporary disk): a 2 GiB import upload, end to end against real Postgres and
// the local object store. A generated file is streamed part by part to the
// signed part URLs, the upload is completed, and the stored object and the
// kernel.files row must both carry the file's exact size. A part whose
// connection drops is re-signed and sent again, as the browser client does
// (at most PART_ATTEMPTS tries); the run reports how many were.
//
//   LIAISON_SOAK=1 bun test src/modules/imports/uploads/uploads.soak.test.ts
//
// SOAK_UPLOAD_BYTES overrides the file size (bytes) for a shorter run.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomFillSync } from "node:crypto"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { importUploads } from "~/db/schema/kernel"
import { deleteObject, headObject } from "~/infra/storage/object-storage"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  completeImportUpload,
  createImportUpload,
  type ImportUploadDeps,
  signImportUploadParts,
} from "./service"

const SOAK = process.env.LIAISON_SOAK === "1"
const SIZE = Number(process.env.SOAK_UPLOAD_BYTES ?? 2 * 1024 * 1024 * 1024)
const MIB = 1024 * 1024
/** Parts in flight at once, as a browser would keep a few connections busy. */
const CONCURRENCY = 4
const PART_ATTEMPTS = 3

describe.skipIf(!SOAK)("SOAK: a 2 GiB multipart import upload", () => {
  let orgId: string
  let userId: string
  let dir: string | null = null
  let storageKey: string | null = null

  function asUser<T>(fn: (deps: ImportUploadDeps) => Promise<T>): Promise<T> {
    return withRlsContext(
      { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} },
      (rlsTx) =>
        fn({
          rlsTx,
          privileged: (reason, f) => withPrivilegedDb(orgId, reason, f),
          delivery: "direct",
        }),
    )
  }

  beforeAll(async () => {
    await acquireTestLock()
    const stamp = Date.now()
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Upload Soak Org', ${`upload-soak-${stamp}`}) RETURNING id
      `),
    )
    orgId = org!.id
    const [u] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`soak-${stamp}@example.test`}, 'soak', 'active', 'h', 1, 1)
        RETURNING id
      `),
    )
    userId = u!.id
  })

  afterAll(async () => {
    if (storageKey) await deleteObject(storageKey).catch(() => undefined)
    if (dir) rmSync(dir, { recursive: true, force: true })
    await releaseTestLock()
  })

  it("streams the file in parts, completes it, and stores every byte", async () => {
    dir = mkdtempSync(join(tmpdir(), "liaison-soak-upload-"))
    const path = join(dir, "export.zip")
    // 1 MiB of random bytes, written over and over: incompressible, cheap to make.
    const block = randomFillSync(new Uint8Array(MIB))
    const w = Bun.file(path).writer()
    for (let written = 0; written < SIZE; ) {
      const n = Math.min(MIB, SIZE - written)
      w.write(n === MIB ? block : block.subarray(0, n))
      written += n
      if (written % (64 * MIB) === 0) await w.flush()
    }
    await w.end()
    expect(statSync(path).size).toBe(SIZE)
    const file = Bun.file(path)

    const t0 = performance.now()
    const created = await asUser((deps) =>
      createImportUpload(
        { orgId, userId, filename: "export.zip", mimeType: "application/zip", size: SIZE },
        deps,
      ),
    )
    const [row] = await db.select().from(importUploads).where(eq(importUploads.id, created.id))
    storageKey = row!.storageKey
    expect(created.mode).toBe("multipart")
    const parts = created.parts ?? []
    expect(parts.length).toBe(created.partCount)

    let next = 0
    let rssPeak = 0
    let resent = 0
    async function sendPart(partNumber: number, firstUrl: string): Promise<void> {
      const start = (partNumber - 1) * created.partSize
      let url = firstUrl
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(url, {
          method: "PUT",
          body: file.slice(start, Math.min(SIZE, start + created.partSize)),
        }).catch((err: unknown) => err as Error)
        if (res instanceof Response && res.status === 200) return
        if (attempt >= PART_ATTEMPTS) {
          throw new Error(
            `part ${partNumber} failed ${attempt} times: ${res instanceof Response ? `HTTP ${res.status}` : res.message}`,
          )
        }
        resent++
        const [fresh] = await asUser((deps) =>
          signImportUploadParts({ orgId, userId, id: created.id, partNumbers: [partNumber] }, deps),
        )
        url = fresh!.url
      }
    }
    async function worker(): Promise<void> {
      for (;;) {
        const p = parts[next++]
        if (!p) return
        await sendPart(p.partNumber, p.url)
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    const sent = (performance.now() - t0) / 1000

    const done = await asUser((deps) =>
      completeImportUpload({ orgId, userId, id: created.id }, deps),
    )
    const secs = (performance.now() - t0) / 1000
    console.info(
      `[SOAK] ${SIZE} B in ${created.partCount} parts of ${created.partSize / MIB} MiB: sent in ${sent.toFixed(1)} s, completed in ${secs.toFixed(1)} s; ${resent} part(s) re-sent; host RSS peak ${(rssPeak / MIB).toFixed(0)} MiB`,
    )
    expect(done.status).toBe("complete")
    expect(done.fileId).toBeTruthy()

    expect((await headObject(storageKey)).contentLength).toBe(SIZE)
    const [stored] = extractRows<{ size_bytes: number; uploaded_by: string }>(
      await db.execute(
        drizzleSql`SELECT size_bytes, uploaded_by FROM kernel.files WHERE id = ${done.fileId}::uuid`,
      ),
    )
    expect(Number(stored!.size_bytes)).toBe(SIZE)
    expect(stored!.uploaded_by).toBe(userId)
  }, 1_800_000)
})
