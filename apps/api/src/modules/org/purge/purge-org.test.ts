// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org purge core against real stores: Postgres (kernel rows and an app
// table under the kernel immutability trigger), Meilisearch, Redis and BullMQ.
// Object storage goes through the purge's seam (an in-memory bucket).
//
// Pinned:
//   - after a purge the residue scan of the org is zero on every store, and a
//     second org seeded alongside is untouched (S2.10);
//   - the org's legal records go too, through the deleting exception, and a
//     trigger an older release generated is regenerated first (A3);
//   - an org whose deletion has not started is refused, and nothing is deleted;
//   - the purge waits for every process to see the deleting state (A4);
//   - a re-run after the org row went is a no-op (resumable);
//   - the final step re-purges a row written after the first pass, and a
//     leftover it cannot remove fails the purge with the org row kept (A4);
//   - BullMQ's own keys carrying the org id are left alone (A31).
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import { closeAllQueues, registerJobWorker, upsertJobScheduler } from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import { generateImmutableTriggerDdl, IMMUTABLE_TRIGGER_DELETING_BRANCH } from "~/modules/apps/ddl"
import {
  markOrgDeleting,
  ORG_DELETING_SETTLE_MS,
  OrgNotDeletingError,
} from "~/modules/org/purge/deleting"
import type { OrgExternalStateDeps } from "~/modules/org/purge/external"
import { OrgPurgeResidueError, purgeOrg } from "~/modules/org/purge/purge-org"
import { residueScan } from "~/modules/org/purge/residue"
import { IndexWriterTestAccess } from "~/modules/search/index-writer"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const tag = crypto.randomUUID().slice(0, 8)
const INDEX = `test_org_purge_${tag}`
const APP_SCHEMA = `app_purgetest_${tag}`

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

/** An in-memory bucket behind the purge's object-storage seam. */
const bucket = new Set<string>()
const objectDeps: OrgExternalStateDeps = {
  deleteObjects: async (orgId) => {
    let n = 0
    for (const key of [...bucket]) {
      if (key.startsWith(`orgs/${orgId}/`)) {
        bucket.delete(key)
        n += 1
      }
    }
    return n
  },
  countObjects: async (orgId) => [...bucket].filter((k) => k.startsWith(`orgs/${orgId}/`)).length,
}

const spies: Array<{ mockRestore: () => void }> = []

async function asAdmin(statements: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    for (const s of statements) await tx.unsafe(s)
  })
}

/** One org with a footprint in every store the purge covers. */
async function seedOrg(name: string): Promise<string> {
  const orgId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const threadId = crypto.randomUUID()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${orgId}, ${name}, ${`purge-${name}-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${userId}, ${orgId}, ${`${name}-${tag}@purge.test`}, ${name}, 'x')`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
    VALUES (${threadId}, ${orgId}, ${`purge-${name}-${tag}`}, 'A thread', ${userId})`
  await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
    VALUES (${threadId}, ${orgId}, ${userId}, 'hello', '{}'::text[])`
  // An issued legal record, under the immutability trigger.
  await sql.unsafe(`INSERT INTO "${APP_SCHEMA}".legal (org_id, sha) VALUES ('${orgId}', 'h')`)
  await redisBullMQ.set(`presence:${orgId}:${userId}`, "1")
  const task = await meili.index(INDEX).addDocuments([
    { id: `${orgId}_kernel_message_1`, org_id: orgId, title: "hello" },
    { id: `${orgId}_kernel_brief_row_1`, org_id: orgId, title: "a decision" },
  ])
  await meili.tasks.waitForTask(task.taskUid)
  registerJobWorker("purgetest", "tick", async () => {})
  await upsertJobScheduler("purgetest", "tick", "0 3 * * *", {
    orgId,
    schedulerId: `tick-${orgId}`,
  })
  bucket.add(`orgs/${orgId}/files/a.pdf`)
  bucket.add(`orgs/${orgId}/exports/export.zip`)
  return orgId
}

/** The scratch legal table's trigger as an OLDER release generated it: no deleting branch. */
function staleTriggerStatements(): string[] {
  return generateImmutableTriggerDdl(APP_SCHEMA, "legal", { retentionYears: 10 })
    .replace(IMMUTABLE_TRIGGER_DELETING_BRANCH, "false")
    .split(";\n")
    .filter((s) => s.trim())
}

/** The trigger body Postgres holds for the scratch legal table. */
async function legalTriggerBody(): Promise<string> {
  const rows = await sql<{ body: string }[]>`
    SELECT p.prosrc AS body FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = ${APP_SCHEMA} AND c.relname = 'legal' AND t.tgname = 'kernel_immutable'`
  return String(rows[0]?.body ?? "")
}

let target = ""
let neighbour = ""
let unmarked = ""
/** Orgs a test seeds for itself; afterAll purges whatever is left of them. */
const extraOrgs: string[] = []

beforeAll(async () => {
  await acquireTestLock()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue(
      meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
    ),
  )
  IndexWriterTestAccess.resetRebuildCache()
  const created = await meili.createIndex(INDEX, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const settings = await meili.index(INDEX).updateSettings({ filterableAttributes: ["org_id"] })
  await meili.tasks.waitForTask(settings.taskUid)

  // A scratch app table with the trigger an OLDER release generated: no
  // deleting branch. The purge must regenerate it before deleting.
  await asAdmin([
    `CREATE SCHEMA "${APP_SCHEMA}"`,
    `CREATE TABLE "${APP_SCHEMA}".legal (id uuid primary key default gen_random_uuid(), org_id uuid not null, created_at timestamptz not null default now(), sha text)`,
    ...staleTriggerStatements(),
  ])
  await sql.unsafe(`GRANT USAGE ON SCHEMA "${APP_SCHEMA}" TO liaison_app`).catch(() => undefined)
  await sql.unsafe(`GRANT ALL ON "${APP_SCHEMA}".legal TO liaison_app`).catch(() => undefined)

  target = await seedOrg("target")
  neighbour = await seedOrg("neighbour")
  unmarked = await seedOrg("unmarked")
}, 60_000)

afterAll(async () => {
  for (const orgId of extraOrgs) {
    await purgeOrg(orgId, {
      reason: "test-purge-cleanup",
      externalDeps: objectDeps,
      settle: false,
    }).catch(() => undefined)
  }
  for (const s of spies) s.mockRestore()
  await asAdmin([`DROP SCHEMA IF EXISTS "${APP_SCHEMA}" CASCADE`])
  for (const orgId of [neighbour, unmarked]) {
    if (!orgId) continue
    await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    for await (const keys of redisBullMQ.scanStream({ match: `*${orgId}*` })) {
      if ((keys as string[]).length > 0) await redisBullMQ.unlink(...(keys as string[]))
    }
  }
  await meili.deleteIndex(INDEX).catch(() => undefined)
  await closeAllQueues()
  await releaseTestLock()
})

describe("the org purge core", () => {
  it("refuses an org whose deletion has not started, and deletes nothing", async () => {
    const before = await residueScan(unmarked, { deps: objectDeps })
    expect(before.total).toBeGreaterThan(0)
    await expect(
      purgeOrg(unmarked, { reason: "test-purge-unmarked", externalDeps: objectDeps }),
    ).rejects.toBeInstanceOf(OrgNotDeletingError)
    const after = await residueScan(unmarked, { deps: objectDeps })
    expect(after).toEqual(before)
    // The legal record of a live org is still guarded.
    await expect(
      sql.unsafe(`DELETE FROM "${APP_SCHEMA}".legal WHERE org_id = '${unmarked}'`).then(() => 0),
    ).rejects.toThrow(/immutable_retention/)
  })

  it("waits for every process to see the deleting state before deleting anything", async () => {
    const markedAt = await markOrgDeleting(unmarked)
    const waits: number[] = []
    let rowsWhenWaiting = -1
    await purgeOrg(unmarked, {
      reason: "test-purge-settle",
      externalDeps: objectDeps,
      sleep: async (ms) => {
        waits.push(ms)
        rowsWhenWaiting = Object.values(
          (await residueScan(unmarked, { deps: objectDeps })).rows,
        ).length
      },
    })
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(ORG_DELETING_SETTLE_MS - 5_000)
    expect(waits[0]).toBeLessThanOrEqual(ORG_DELETING_SETTLE_MS)
    // Nothing was deleted while it waited.
    expect(rowsWhenWaiting).toBeGreaterThan(0)
    expect(markedAt).toBeInstanceOf(Date)
    expect((await residueScan(unmarked, { deps: objectDeps })).orgRow).toBe(false)
    unmarked = ""
  })

  it("leaves zero residue in every store, legal records included, and the neighbour untouched", async () => {
    const neighbourBefore = await residueScan(neighbour, { deps: objectDeps })
    const targetBefore = await residueScan(target, { deps: objectDeps })
    expect(targetBefore.rows[`${APP_SCHEMA}.legal`]).toBe(1)
    expect(targetBefore.searchDocuments).toBe(2)
    expect(targetBefore.redisKeys).toBeGreaterThanOrEqual(1)
    expect(targetBefore.jobSchedulers).toBe(1)
    expect(targetBefore.objects).toBe(2)

    // A BullMQ key carrying the org id: removing it from under its queue would
    // break the queue for every tenant, so the purge leaves it alone.
    const bullKey = `${bullPrefix}:purgetest:${target}`
    await redisBullMQ.set(bullKey, "1")

    // Marked a minute ago: every process has long seen it, no wait.
    await markOrgDeleting(target, new Date(Date.now() - 60_000))
    const steps: string[] = []
    const result = await purgeOrg(target, {
      reason: "test-purge",
      externalDeps: objectDeps,
      onStep: (step) => {
        steps.push(step)
      },
    })

    expect(result.orgRowDeleted).toBe(true)
    expect(result.residue?.total).toBe(0)
    expect(result.deleted[`${APP_SCHEMA}.legal`]).toBe(1)
    expect(steps).toEqual([
      "triggers",
      "disconnect",
      "rows",
      "search",
      "objects",
      "redis",
      "schedulers",
      "verify",
      "org-row",
      "release",
    ])
    // The stale trigger was regenerated with the deleting branch.
    expect(await legalTriggerBody()).toContain(IMMUTABLE_TRIGGER_DELETING_BRANCH)

    const after = await residueScan(target, { deps: objectDeps })
    expect(after.total).toBe(0)
    expect(after.orgRow).toBe(false)
    expect(after.rows).toEqual({})
    expect(await redisBullMQ.get(bullKey)).toBe("1")
    await redisBullMQ.del(bullKey)

    const neighbourAfter = await residueScan(neighbour, { deps: objectDeps })
    expect(neighbourAfter).toEqual(neighbourBefore)
    expect(neighbourAfter.rows[`${APP_SCHEMA}.legal`]).toBe(1)
    expect(neighbourAfter.searchDocuments).toBe(2)
  })

  it("a re-run after the org row went does nothing but release", async () => {
    const steps: string[] = []
    const result = await purgeOrg(target, {
      reason: "test-purge-rerun",
      externalDeps: objectDeps,
      onStep: (step) => {
        steps.push(step)
      },
    })
    expect(result.orgRowDeleted).toBe(false)
    expect(steps).toEqual(["release"])
  })

  it("the final step removes a row written after the first pass", async () => {
    const late = await seedOrg("late")
    extraOrgs.push(late)
    await markOrgDeleting(late, new Date(Date.now() - 60_000))
    const result = await purgeOrg(late, {
      reason: "test-purge-straggler",
      externalDeps: objectDeps,
      onStep: async (step) => {
        // A write that lands after the row pass (a job admitted before the mark).
        if (step === "objects") {
          await sql.unsafe(
            `INSERT INTO "${APP_SCHEMA}".legal (org_id, sha) VALUES ('${late}', 'late')`,
          )
        }
      },
    })
    expect(result.orgRowDeleted).toBe(true)
    expect(result.residue?.total).toBe(0)
    // One row from the first pass, the straggler from the final one.
    expect(result.deleted[`${APP_SCHEMA}.legal`]).toBe(2)
    const after = await residueScan(late, { deps: objectDeps })
    expect(after.total).toBe(0)
    expect(after.rows).toEqual({})
  })

  it("leftover data it cannot remove fails the purge and keeps the org row", async () => {
    const stuck = await seedOrg("stuck")
    extraOrgs.push(stuck)
    await markOrgDeleting(stuck, new Date(Date.now() - 60_000))
    // A store that refuses to delete: one object stays.
    const stubborn: OrgExternalStateDeps = {
      deleteObjects: async () => 0,
      countObjects: async () => 1,
    }
    const steps: string[] = []
    const err = await purgeOrg(stuck, {
      reason: "test-purge-residue",
      externalDeps: stubborn,
      onStep: (step) => {
        steps.push(step)
      },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OrgPurgeResidueError)
    expect((err as OrgPurgeResidueError).residue.objects).toBe(1)
    expect(steps).toContain("verify")
    expect(steps).not.toContain("org-row")
    expect(steps).not.toContain("release")
    const after = await residueScan(stuck, { deps: objectDeps })
    expect(after.orgRow).toBe(true)
  })

  it("the demo reaper's option runs no trigger DDL", async () => {
    await asAdmin(staleTriggerStatements())
    expect(await legalTriggerBody()).not.toContain(IMMUTABLE_TRIGGER_DELETING_BRANCH)
    const demo = await seedOrg("nodll")
    extraOrgs.push(demo)
    await markOrgDeleting(demo, new Date(Date.now() - 60_000))
    const details: Record<string, unknown> = {}
    // A non-demo org: its legal row is refused by the stale body, which is the point.
    await purgeOrg(demo, {
      reason: "test-purge-no-ddl",
      externalDeps: objectDeps,
      regenerateTriggers: false,
      onStep: (step, detail) => {
        details[step] = detail
      },
    }).catch(() => undefined)
    expect(details.triggers).toEqual({ skipped: true })
    expect(await legalTriggerBody()).not.toContain(IMMUTABLE_TRIGGER_DELETING_BRANCH)
  })
})
