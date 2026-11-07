// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The nightly storage estimate on real rows: what it counts, that it is told
// once per crossing and never blocks, and that a part it cannot measure leaves
// a floor, never a false "back under the cap".

import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { sql } from "~/db"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import * as searchClient from "~/infra/search/client"
import { _setEdition } from "~/lib/edition"
import { declaredEmits } from "~/modules/apps/app-registries"
import { currentPlanUsage } from "~/modules/billing-managed/usage"
import {
  estimateCrossing,
  isOverCap,
  runStorageEstimates,
  SAMPLE_ROWS,
  THUMBNAIL_BYTES,
  tableBytes,
} from "~/modules/cloud/storage-estimate"
import { getOrgUsage } from "~/modules/org/caps"
import { seedContext } from "~/seed/context"
import { seedOrgBillingState } from "~/seed/factories/billing/billing"
import { seedFileRow } from "~/seed/factories/files/file-row"
import { insertUnarmedMail } from "~/seed/factories/mail/conversations"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const GB = 1024 ** 3
const FAST = { pauseMs: 0 }
const NIGHT = new Date("2026-11-07T02:40:00.000Z")
const nextNight = (n: number) => new Date(NIGHT.getTime() + n * 86_400_000)

function meiliWith(documents: number, opts: { fail?: boolean } = {}) {
  const fake = {
    getStats: async () => {
      if (opts.fail) throw new Error("search is down")
      return { databaseSize: 4_000_000, indexes: { live: { numberOfDocuments: 1000 } } }
    },
    index: () => ({ getDocuments: async () => ({ total: documents, results: [] }) }),
  }
  return spyOn(searchClient, "getMeili").mockReturnValue(fake as never)
}

async function billedOrg(caps: Record<string, unknown>) {
  const { orgId } = await minimal.secondOrg()
  await sql`UPDATE kernel.organizations SET caps = ${JSON.stringify(caps)}::jsonb WHERE id = ${orgId}`
  await seedOrgBillingState(orgId, { includedCredits: 0 })
  return orgId
}

/** `bodies.length` messages in the org's shared mailbox, stored as they are given. */
async function seedMail(orgId: string, bodies: string[]) {
  await insertUnarmedMail(seedContext({ orgId, now: new Date() }), {
    domain: "estimate.test",
    mailboxes: [
      {
        box: "shared",
        ownerUserId: null,
        email: `${randomUUID()}@estimate.test`,
        displayName: "Shared",
      },
    ],
    conversations: [
      {
        key: "estimate",
        box: "shared",
        subject: "s",
        status: "open",
        labels: [],
        isRead: true,
        isStarred: false,
        messages: bodies.map((body) => ({
          direction: "inbound" as const,
          fromName: "From",
          fromEmail: "from@estimate.test",
          toName: "To",
          toEmail: "to@estimate.test",
          hoursAgo: 1,
          body,
        })),
      },
    ],
  })
}

async function seedFile(orgId: string, sizeBytes: number, thumb: boolean) {
  await seedFileRow({
    orgId,
    app: "knowledge",
    entityType: "document",
    entityId: randomUUID(),
    filename: "f.png",
    mimeType: "image/png",
    sizeBytes,
    storageKey: `orgs/${orgId}/${randomUUID()}`,
    thumbnailKey: thumb ? `orgs/${orgId}/${randomUUID()}.thumb.webp` : null,
  })
}

async function estimateRow(orgId: string) {
  const [row] =
    await sql`SELECT storage_estimate FROM kernel.org_billing_state WHERE org_id = ${orgId}`
  return row.storage_estimate as {
    bytes: number
    parts: Record<string, number | null>
    partial: boolean
    overCap: boolean
    measuredAt: string
  } | null
}

async function outboxOf(orgId: string) {
  return (
    await sql`
    SELECT data FROM kernel.control_plane_outbox
     WHERE type = 'storage.estimate' AND data->>'orgId' = ${orgId} ORDER BY created_at, id`
  ).map((r) => r.data as Record<string, unknown>)
}

async function noticesOf(orgId: string) {
  return (
    await sql`
    SELECT payload FROM kernel.pending_events
     WHERE payload->>'orgId' = ${orgId} AND payload->'data'->>'cap' = 'storageEstimate'`
  ).map((r) => (r.payload as { data: Record<string, unknown> }).data)
}

beforeAll(async () => {
  await acquireTestLock()
  // tx.queueEvent refuses an undeclared kernel event once the set is loaded, as on a server.
  declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
  _setEdition("managed")
})
afterEach(() => {
  mock.restore()
})
afterAll(async () => {
  _setEdition(null)
  await releaseTestLock()
})

describe("the arithmetic", () => {
  it("a table's bytes: rows x (sample average + the row's fixed part), grown by its indexes", () => {
    expect(tableBytes(10, 1000, 0)).toBe(11_200)
    expect(tableBytes(10, 1000, 0.5)).toBe(16_800)
    expect(tableBytes(0, 0, 3)).toBe(0)
  })
  it("told once per crossing", () => {
    expect(estimateCrossing(false, false)).toBe("none")
    expect(estimateCrossing(true, true)).toBe("none")
    expect(estimateCrossing(false, true)).toBe("over")
    expect(estimateCrossing(true, false)).toBe("back")
  })
  it("no cap means never over; at the cap is not over", () => {
    expect(isOverCap(10 ** 15, null)).toBe(false)
    expect(isOverCap(10, 10)).toBe(false)
    expect(isOverCap(11, 10)).toBe(true)
  })
})

describe("the nightly run", () => {
  it("does not run on a self-hosted server: nothing measured, nothing written", async () => {
    const orgId = await billedOrg({ storageGb: 1 })
    _setEdition("self_hosted")
    try {
      expect(await runStorageEstimates(NIGHT, FAST)).toBe(0)
      expect(await estimateRow(orgId)).toBeNull()
    } finally {
      _setEdition("managed")
    }
  })

  it("counts mail, files, thumbnails and the org's share of the search index", async () => {
    const orgId = await billedOrg({ storageGb: 10 })
    // A body that hardly compresses, so its stored size is near its length.
    await seedMail(
      orgId,
      Array.from({ length: 5 }, () => randomBytes(10_000).toString("hex")),
    )
    await seedFile(orgId, 1_000_000, true)
    meiliWith(25)
    await runStorageEstimates(NIGHT, FAST)
    const e = await estimateRow(orgId)
    expect(e?.parts.files).toBe(1_000_000)
    expect(e?.parts.thumbnails).toBe(THUMBNAIL_BYTES)
    expect(e?.parts.search).toBe(100_000) // 25 documents x 4 MB / 1000 documents
    expect(e?.parts.mail).toBeGreaterThan(5 * 20_000 * 0.45) // hex compresses at most about 2:1
    expect(e?.bytes).toBeGreaterThan(1_100_000)
    expect(e?.partial).toBe(false)
    expect(e?.overCap).toBe(false)
    expect(e?.measuredAt).toBe(NIGHT.toISOString())
  })

  it("an org with more rows than the sample is measured from the sample, times its row count", async () => {
    expect(SAMPLE_ROWS).toBeGreaterThan(0)
    const atSample = await billedOrg({})
    const overSample = await billedOrg({})
    await seedMail(atSample, Array(SAMPLE_ROWS).fill("x".repeat(100)))
    await seedMail(overSample, Array(SAMPLE_ROWS * 2).fill("x".repeat(100)))
    meiliWith(0)
    await runStorageEstimates(NIGHT, FAST)
    // Both read the same number of rows' sizes and the same size per row, so only the
    // row count can double the second org's part.
    const at = (await estimateRow(atSample))?.parts.mail as number
    const over = (await estimateRow(overSample))?.parts.mail as number
    expect(at).toBeGreaterThan(SAMPLE_ROWS * 100)
    expect(over).toBeGreaterThan(at * 1.9)
    expect(over).toBeLessThan(at * 2.1)
  })

  it("over the cap: admins and Control are told once; back under tells Control only; a new crossing tells again", async () => {
    const orgId = await billedOrg({ storageGb: 1 })
    await seedFile(orgId, 2 * GB, false)
    meiliWith(0)

    await runStorageEstimates(NIGHT, FAST)
    expect((await estimateRow(orgId))?.overCap).toBe(true)
    let notices = await noticesOf(orgId)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      threshold: 100,
      limit: 1,
      settingsRoute: "/settings/admin/org",
    })
    expect(String(notices[0]?.summary)).toContain("Nothing is blocked")
    expect(await outboxOf(orgId)).toMatchObject([
      { orgId, day: "2026-11-07", capBytes: GB, over: true },
    ])

    await runStorageEstimates(nextNight(1), FAST)
    expect(await noticesOf(orgId)).toHaveLength(1)
    expect(await outboxOf(orgId)).toHaveLength(1)

    await sql`UPDATE kernel.files SET size_bytes = 10 WHERE org_id = ${orgId}`
    await runStorageEstimates(nextNight(2), FAST)
    expect((await estimateRow(orgId))?.overCap).toBe(false)
    expect(await noticesOf(orgId)).toHaveLength(1)
    expect((await outboxOf(orgId)).at(-1)).toMatchObject({ day: "2026-11-09", over: false })

    await sql`UPDATE kernel.files SET size_bytes = ${2 * GB} WHERE org_id = ${orgId}`
    await runStorageEstimates(nextNight(3), FAST)
    notices = await noticesOf(orgId)
    expect(notices).toHaveLength(2)
    expect(await outboxOf(orgId)).toHaveLength(3)
  })

  it("no cap: never warns", async () => {
    const orgId = await billedOrg({})
    await seedFile(orgId, 2 * GB, false)
    meiliWith(0)
    await runStorageEstimates(NIGHT, FAST)
    expect((await estimateRow(orgId))?.overCap).toBe(false)
    expect(await noticesOf(orgId)).toHaveLength(0)
    expect(await outboxOf(orgId)).toHaveLength(0)
  })

  it("search down: the total is a floor, marked partial, and it cannot prove an org back under its cap", async () => {
    const orgId = await billedOrg({ storageGb: 1 })
    await seedFile(orgId, 2 * GB, false)
    meiliWith(0)
    await runStorageEstimates(NIGHT, FAST)
    await sql`UPDATE kernel.files SET size_bytes = 10 WHERE org_id = ${orgId}`
    mock.restore()
    meiliWith(0, { fail: true })
    await runStorageEstimates(nextNight(1), FAST)
    const e = await estimateRow(orgId)
    expect(e?.partial).toBe(true)
    expect(e?.parts.search).toBeNull()
    expect(e?.overCap).toBe(true)
    expect(await outboxOf(orgId)).toHaveLength(1)
  })

  it("a closed org is skipped", async () => {
    const orgId = await billedOrg({ storageGb: 1 })
    await sql`UPDATE kernel.org_billing_state SET closed_at = now() WHERE org_id = ${orgId}`
    meiliWith(0)
    await runStorageEstimates(NIGHT, FAST)
    expect(await estimateRow(orgId)).toBeNull()
  })

  it("a run out of budget stops; what it did not reach is still unmeasured, and first in line next night", async () => {
    const orgId = await billedOrg({})
    meiliWith(0)
    expect(await runStorageEstimates(NIGHT, { pauseMs: 0, budgetMs: -1 })).toBe(0)
    expect(await estimateRow(orgId)).toBeNull()
    expect(await runStorageEstimates(NIGHT, FAST)).toBeGreaterThan(0)
    expect(await estimateRow(orgId)).not.toBeNull()
  })
})

describe("what reads it", () => {
  it("the Usage page and the plan usage carry the estimate; both are silent before a measure", async () => {
    const orgId = await billedOrg({ storageGb: 1 })
    expect((await getOrgUsage(orgId)).storageEstimate).toBeNull()
    expect(await currentPlanUsage(orgId)).not.toHaveProperty("storageEstimateBytes")

    await seedFile(orgId, 2 * GB, false)
    meiliWith(0)
    await runStorageEstimates(NIGHT, FAST)
    const usage = await getOrgUsage(orgId)
    expect(usage.storageEstimate).toMatchObject({
      limitGb: 1,
      measuredAt: NIGHT.toISOString(),
      partial: false,
      overCap: true,
    })
    expect(usage.storageEstimate?.usedGb).toBeGreaterThanOrEqual(2)
    const plan = await currentPlanUsage(orgId)
    expect(plan.storageBytes).toBe(2 * GB)
    expect(plan.storageEstimateBytes).toBeGreaterThanOrEqual(2 * GB)
  })
})
