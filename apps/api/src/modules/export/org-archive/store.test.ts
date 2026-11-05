// SPDX-License-Identifier: FSL-1.1-ALv2
// kernel.org_exports rows and their upkeep: one queued or running export per
// org (partial unique index, A12), the weekly orphan GC keeps an unexpired
// archive (A1), the sweep expires archives after 7 days and fails stalled runs.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { deleteObject, headObject, putObject } from "~/infra/storage/object-storage"
import { declaredEmits } from "~/modules/apps/app-registries"
import {
  claimOrgExport,
  completeOrgExport,
  createOrgExport,
  failOrgExport,
  getOrgExport,
  heartbeatOrgExport,
  OrgExportRunningError,
  sweepOrgExports,
} from "~/modules/export/org-archive/store"
import { orgExportObjectKey } from "~/modules/export/org-archive/writer"
import { runOrphanGcForOrg } from "~/modules/files/orphan-gc"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const tag = () => crypto.randomUUID().slice(0, 8)
const keys: string[] = []

async function newOrg(): Promise<string> {
  return (await ensureOrg({ slug: `oexp-st-${tag()}`, name: "Export Store" })).orgId
}

/** A completed export with a real object behind it. */
async function completedExport(orgId: string): Promise<{ id: string; key: string }> {
  const row = await createOrgExport(orgId, { userId: null, via: "cli" })
  const run = await claimOrgExport(orgId, row.id)
  if (!run?.runId) throw new Error("claim gave no run id")
  const key = orgExportObjectKey(orgId, row.id, run.runId)
  await putObject({ key, body: new Uint8Array([80, 75, 5, 6]), contentType: "application/zip" })
  keys.push(key)
  await completeOrgExport(orgId, row.id, run.runId, { objectKey: key, bytes: 4, manifest: {} })
  return { id: row.id, key }
}

beforeAll(async () => {
  await acquireTestLock()
}, 60_000)

afterAll(async () => {
  for (const k of keys) await deleteObject(k).catch(() => undefined)
  await releaseTestLock()
})

describe("org export rows", () => {
  it("refuses a second queued or running export of the same org with the running id", async () => {
    const orgId = await newOrg()
    const first = await createOrgExport(orgId, { userId: null, via: "cli" })
    const err = await createOrgExport(orgId, { userId: null, via: "cli" }).catch((e) => e)
    expect(err).toBeInstanceOf(OrgExportRunningError)
    expect((err as OrgExportRunningError).runningId).toBe(first.id)
    // The index itself, not only the code path: a raw second insert fails.
    const raw = await sql`
      INSERT INTO kernel.org_exports (org_id, status) VALUES (${orgId}, 'running')
    `.catch((e) => e)
    expect(String((raw as { code?: string }).code)).toBe("23505")
    // Another org is not affected.
    const other = await createOrgExport(await newOrg(), { userId: null, via: "cli" })
    expect(other.status).toBe("queued")
  }, 30_000)

  it("writes the requested and completed audit rows", async () => {
    const orgId = await newOrg()
    const { id } = await completedExport(orgId)
    const rows = await sql`
      SELECT action FROM kernel.audit_log WHERE org_id = ${orgId} AND entity_id = ${id}
      ORDER BY timestamp, action DESC`
    expect(rows.map((r) => r.action)).toEqual(["org.export.requested", "org.export.completed"])
  }, 30_000)
})

describe("ready notice", () => {
  it("an export started from Settings completes and queues the ready notice for whoever asked", async () => {
    // Load the kernel emit set as a running server does (initEventBus), so an
    // undeclared notice fails here as it does in production.
    declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
    // An org provisioned with its admin, who starts the export.
    const { orgId, adminUserId } = await minimal.secondOrg()
    const row = await createOrgExport(orgId, { userId: adminUserId, via: "settings" })
    const run = await claimOrgExport(orgId, row.id)
    if (!run?.runId) throw new Error("claim gave no run id")
    const key = orgExportObjectKey(orgId, row.id, run.runId)
    const done = await completeOrgExport(orgId, row.id, run.runId, {
      objectKey: key,
      bytes: 4,
      manifest: {},
    })
    expect(done?.status).toBe("completed")
    const events = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'org_export'`
    expect(
      events.map((e) => (e.payload as { data: { notifyUserId: string } }).data.notifyUserId),
    ).toEqual([adminUserId])
  }, 30_000)
})

describe("run token (K3)", () => {
  it("a takeover issues a new run id; the old run can no longer heartbeat, complete or fail", async () => {
    const orgId = await newOrg()
    const row = await createOrgExport(orgId, { userId: null, via: "cli" })
    const first = await claimOrgExport(orgId, row.id)
    expect(first?.runId).toBeTruthy()
    // Not yet stale: a second claim is refused.
    expect(await claimOrgExport(orgId, row.id)).toBeNull()
    await sql`UPDATE kernel.org_exports SET updated_at = now() - interval '3 minutes' WHERE id = ${row.id}`
    const second = await claimOrgExport(orgId, row.id)
    expect(second?.runId).toBeTruthy()
    expect(second?.runId).not.toBe(first?.runId)
    const oldRun = first?.runId ?? ""
    const newRun = second?.runId ?? ""
    expect(await heartbeatOrgExport(orgId, row.id, oldRun)).toBe(false)
    const oldKey = orgExportObjectKey(orgId, row.id, oldRun)
    expect(
      await completeOrgExport(orgId, row.id, oldRun, { objectKey: oldKey, bytes: 1, manifest: {} }),
    ).toBeNull()
    expect(await failOrgExport(orgId, row.id, { code: "INTERNAL" }, oldRun)).toBe(false)
    expect((await getOrgExport(orgId, row.id))?.status).toBe("running")
    // The holder of the new token still owns the row.
    expect(await heartbeatOrgExport(orgId, row.id, newRun)).toBe(true)
    const newKey = orgExportObjectKey(orgId, row.id, newRun)
    expect(newKey).not.toBe(oldKey)
    const done = await completeOrgExport(orgId, row.id, newRun, {
      objectKey: newKey,
      bytes: 1,
      manifest: {},
    })
    expect(done?.objectKey).toBe(newKey)
  }, 30_000)
})

describe("orphan GC and expiry", () => {
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

  async function gcDeletes(orgId: string, key: string): Promise<boolean> {
    const deleted: string[] = []
    await runOrphanGcForOrg(orgId, {
      listOrgPrefixIter: async function* () {
        yield { Key: key, LastModified: old }
      },
      deleteObjects: async (batch: string[]) => {
        deleted.push(...batch)
      },
    })
    return deleted.includes(key)
  }

  it("the weekly orphan GC keeps an unexpired export archive, and lets an expired one go", async () => {
    const orgId = await newOrg()
    const { id, key } = await completedExport(orgId)
    expect(await gcDeletes(orgId, key)).toBe(false)
    await sql`UPDATE kernel.org_exports SET expires_at = now() - interval '1 minute' WHERE id = ${id}`
    expect(await gcDeletes(orgId, key)).toBe(true)
  }, 30_000)

  it("the sweep deletes an archive past its expiry and marks the row expired", async () => {
    const orgId = await newOrg()
    const fresh = await completedExport(orgId)
    // A second export in the same org once the first finished.
    const due = await completedExport(orgId)
    await sql`UPDATE kernel.org_exports SET expires_at = now() - interval '1 minute' WHERE id = ${due.id}`
    await sweepOrgExports()
    const dueRow = await getOrgExport(orgId, due.id)
    expect(dueRow?.status).toBe("expired")
    expect(dueRow?.objectKey).toBeNull()
    expect(await headObject(due.key).catch(() => null)).toBeNull()
    expect((await getOrgExport(orgId, fresh.id))?.status).toBe("completed")
    expect(await headObject(fresh.key).catch(() => null)).not.toBeNull()
  }, 30_000)

  it("the sweep fails a running export whose heartbeat stopped more than 15 minutes ago", async () => {
    const orgId = await newOrg()
    const row = await createOrgExport(orgId, { userId: null, via: "cli" })
    await claimOrgExport(orgId, row.id)
    await sql`UPDATE kernel.org_exports SET updated_at = now() - interval '16 minutes' WHERE id = ${row.id}`
    await sweepOrgExports()
    const after = await getOrgExport(orgId, row.id)
    expect(after?.status).toBe("failed")
    expect(after?.error).toBe("STALLED")
    // The org may export again.
    expect((await createOrgExport(orgId, { userId: null, via: "cli" })).status).toBe("queued")
  }, 30_000)

  it("the sweep fails a queued export its job never picked up (K6), and keeps a recent one", async () => {
    const orgId = await newOrg()
    const lost = await createOrgExport(orgId, { userId: null, via: "cli" })
    await sql`UPDATE kernel.org_exports SET created_at = now() - interval '26 hours',
      updated_at = now() - interval '26 hours' WHERE id = ${lost.id}`
    await sweepOrgExports()
    const after = await getOrgExport(orgId, lost.id)
    expect(after?.status).toBe("failed")
    expect(after?.error).toBe("QUEUE_LOST")
    const recent = await createOrgExport(orgId, { userId: null, via: "cli" })
    await sweepOrgExports()
    expect((await getOrgExport(orgId, recent.id))?.status).toBe("queued")
  }, 30_000)

  it("stores an error code, not the internal message (K8)", async () => {
    const orgId = await newOrg()
    const row = await createOrgExport(orgId, { userId: null, via: "cli" })
    await failOrgExport(orgId, row.id, {
      code: "QUEUE_FAILED",
      detail: "connect ECONNREFUSED redis.internal:6379",
    })
    const after = await getOrgExport(orgId, row.id)
    expect(after?.error).toBe("QUEUE_FAILED")
    const [audit] = await sql`
      SELECT metadata FROM kernel.audit_log
      WHERE entity_id = ${row.id} AND action = 'org.export.failed'`
    expect(JSON.stringify(audit?.metadata)).toContain("redis.internal")
  }, 30_000)
})
