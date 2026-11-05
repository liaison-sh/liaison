// SPDX-License-Identifier: FSL-1.1-ALv2
// e2e-own-server: the GC walks every object under the org's object-store
// prefix, and a shared e2e lane keeps one org id across files, so the objects
// earlier files left there would be in its walk (packages/test-helpers/src/e2e-lane.ts).
// [Phase 10 BE-4] Orphan GC — deletes stale unreferenced objects only
// ---------------------------------------------------------------------------
// Spec refs: S8, §3.2.10.
//
// Verifies that `runOrphanGcForOrg` deletes objects under the org prefix
// that are (a) older than the 24 h grace window AND (b) not referenced by
// any `kernel.files` row's `storage_key` or `thumbnail_key`. Referenced
// objects survive even if they're old; recent unreferenced objects survive
// (still inside the grace window).
//
// Mechanism:
//   1. Upload a real file via the /api/files/* flow → produces a referenced
//      object in the object store plus its row in `kernel.files` (and asynchronously a
//      thumbnail).
//   2. Drop two raw objects into the object store under the same `orgs/<orgId>/...`
//      prefix — one we want collected, one we want preserved as "recent".
//   3. Inject `now = realNow + 25 h` into `runOrphanGcForOrg` so the cutoff
//      slides past the just-uploaded objects without backdating the object store.
//   4. Assert the orphan was deleted, both referenced and recent objects
//      remain.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import {
  deleteObjects,
  getObjectBuffer,
  listOrgPrefixIter,
  putObject,
} from "~/infra/storage/object-storage"
import { collectOrphanKeysForOrg } from "~/modules/files/orphan-gc"
import { ks, seedTicket } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

const ORG_HEAD_OFFSET_MS = 25 * 60 * 60 * 1000 // > 24 h grace window
const FIVE_KB = 5 * 1024

async function uploadFileViaApi(
  env: WorkerEnv,
  token: string,
  entityId: string,
  bytes: Buffer,
): Promise<{ id: string }> {
  const presign = await api(env.serverUrl, "/api/files/upload-url", {
    token,
    body: {
      app: "tickets",
      entityType: "ticket",
      entityId,
      filename: "referenced.bin",
      mimeType: "application/octet-stream",
      sizeBytes: bytes.byteLength,
    },
  })
  if (presign.status !== 200) {
    throw new Error(`upload-url failed: ${presign.status} ${JSON.stringify(presign.body)}`)
  }
  const { uploadUrl, fileToken } = presign.body.data as {
    uploadUrl: string
    fileToken: string
  }
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  })
  if (!put.ok) throw new Error(`Object store PUT failed: ${put.status} ${await put.text()}`)
  const confirm = await api(env.serverUrl, "/api/files/confirm", {
    token,
    body: { fileToken },
  })
  if (confirm.status !== 200) {
    throw new Error(`confirm failed: ${confirm.status} ${JSON.stringify(confirm.body)}`)
  }
  return { id: (confirm.body.data as { id: string }).id }
}

describe("Orphan GC deletes stale unreferenced objects only", () => {
  let env: WorkerEnv
  let world: TestWorld
  let ticketId: string
  let referencedFileId: string
  let referencedStorageKey: string
  const staleOrphanKey = `orgs/__pending__/be4-stale-${Date.now()}-${randomBytes(4).toString("hex")}`
  const recentOrphanKey = `orgs/__pending__/be4-recent-${Date.now()}-${randomBytes(4).toString("hex")}`

  beforeAll(async () => {
    const result = await setupScenario({ seed: 704, org: { name: "Orphan GC Org" } })
    env = result.env
    world = result.world

    const t = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Orphan GC ticket",
      team: "support-us",
    })
    ticketId = t.id

    const ref = await uploadFileViaApi(env, world.admin.token, ticketId, randomBytes(FIVE_KB))
    referencedFileId = ref.id

    const rows = await env.db.sql.unsafe(
      `SELECT storage_key FROM ${env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"}.files WHERE id = $1`,
      [referencedFileId],
    )
    referencedStorageKey = rows[0]!.storage_key as string

    // Override the placeholder __pending__ in our orphan key paths with the
    // real org id so listOrgPrefixIter({ orgId }) finds them.
    const orgKeyStale = staleOrphanKey.replace("__pending__", world.org.id)
    const orgKeyRecent = recentOrphanKey.replace("__pending__", world.org.id)
    Object.assign(globalThis as any, {
      __BE4_STALE_KEY__: orgKeyStale,
      __BE4_RECENT_KEY__: orgKeyRecent,
    })

    await putObject({
      key: orgKeyStale,
      body: Buffer.from("stale orphan content"),
      contentType: "application/octet-stream",
    })
    await putObject({
      key: orgKeyRecent,
      body: Buffer.from("recent orphan content"),
      contentType: "application/octet-stream",
    })
  }, 180_000)

  afterAll(async () => {
    // Best-effort cleanup of any objects we created that weren't deleted by
    // the GC (in case the test failed before the GC ran).
    const keys = [
      (globalThis as any).__BE4_STALE_KEY__,
      (globalThis as any).__BE4_RECENT_KEY__,
    ].filter(Boolean) as string[]
    try {
      await deleteObjects(keys)
    } catch {
      /* best effort */
    }
    await teardownScenario(env, world)
  }, 30_000)

  it("collects the stale orphan, preserves referenced + recent objects", async () => {
    const staleKey = (globalThis as any).__BE4_STALE_KEY__ as string
    const recentKey = (globalThis as any).__BE4_RECENT_KEY__ as string

    // Sanity: all three objects are present BEFORE the GC runs.
    const beforeKeys = new Set<string>()
    for await (const obj of listOrgPrefixIter({ orgId: world.org.id })) {
      beforeKeys.add(obj.Key)
    }
    expect(beforeKeys.has(referencedStorageKey)).toBe(true)
    expect(beforeKeys.has(staleKey)).toBe(true)
    expect(beforeKeys.has(recentKey)).toBe(true)

    // Build the referenced-keys set directly against the worker-prefixed
    // kernel schema — the production `loadReferencedKeysForOrg` uses
    // `schemaRef("kernel")` which is `kernel` in the test process (not
    // `w0_kernel`). Building the set in-test lets us exercise the real
    // GC selection logic (`collectOrphanKeysForOrg`) and the real
    // `deleteObjects` storage call without crossing process boundaries.
    const refRows = await env.db.sql.unsafe(
      `SELECT storage_key, thumbnail_key FROM ${ks(env)}.files WHERE org_id = $1`,
      [world.org.id],
    )
    const referenced = new Set<string>()
    for (const r of refRows) {
      if (r.storage_key) referenced.add(r.storage_key as string)
      if (r.thumbnail_key) referenced.add(r.thumbnail_key as string)
    }

    // Pin `now = realNow + 25 h` so the stale-orphan check sees our
    // freshly uploaded objects as older than the 24 h grace window. The
    // recent-orphan check uses an even-newer LastModified yielded by a
    // custom lister so it's preserved (inside the grace window).
    const realNow = Date.now()
    const cutoffNow = new Date(realNow + ORG_HEAD_OFFSET_MS)
    const orphans = await collectOrphanKeysForOrg(world.org.id, referenced, {
      now: cutoffNow,
      listOrgPrefixIter: async function* ({ orgId }) {
        for await (const obj of listOrgPrefixIter({ orgId })) {
          if (obj.Key === recentKey) {
            // Forced "recent" — newer than cutoff (realNow + 1 h)
            yield { ...obj, LastModified: new Date(realNow + ORG_HEAD_OFFSET_MS - 1000) }
          } else {
            yield obj
          }
        }
      },
    })

    expect(orphans).toContain(staleKey)
    expect(orphans).not.toContain(referencedStorageKey)
    expect(orphans).not.toContain(recentKey)

    await deleteObjects(orphans)

    const afterKeys = new Set<string>()
    for await (const obj of listOrgPrefixIter({ orgId: world.org.id })) {
      afterKeys.add(obj.Key)
    }
    expect(afterKeys.has(staleKey)).toBe(false)
    expect(afterKeys.has(referencedStorageKey)).toBe(true)
    expect(afterKeys.has(recentKey)).toBe(true)

    // Referenced object content still readable.
    const buf = await getObjectBuffer(referencedStorageKey)
    expect(buf.byteLength).toBe(FIVE_KB)
  }, 60_000)
})
