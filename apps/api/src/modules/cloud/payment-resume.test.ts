// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3R-18: while payment was required the cell embedded nothing (keyword only),
// so the push that brings the org back to `active` from `past_due` or
// `suspended` starts its embedding backfill, once. Any other transition does not.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Compare the new status only (not the previous one): active → active
//    re-pushes would each start a backfill.
//  * Read the previous status after the upsert: it is already `active`, nothing
//    starts.
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import type { CloudBillingPushRequest } from "@liaison/control-plane-contract"
import { sql } from "~/db"
import { EMBEDDING_BACKFILL_JOB } from "~/infra/jobs/embedding-backfill"
import * as jobs from "~/infra/jobs/jobs"
import { applyBillingPush, rerunMissedOneShots } from "~/modules/cloud/billing"
import { STATUS_TTL_MS } from "~/modules/cloud/billing-status"
import { seedOrgRow } from "~/seed/factories/org/rows"

const orgs: string[] = []
let resumed: string[] = []
const deps = {
  onPaymentResumed: async (orgId: string) => {
    resumed.push(orgId)
  },
}

async function newOrg(): Promise<string> {
  const id = randomUUID()
  orgs.push(id)
  await seedOrgRow({ id, name: "Resume org", slug: `resume-${id.slice(0, 8)}` })
  return id
}

let version = 1
async function push(orgId: string, status: CloudBillingPushRequest["status"]): Promise<void> {
  const req = {
    orgId,
    version: version++,
    plan: "base",
    status,
    periodEnd: "2026-12-01T00:00:00.000Z",
    includedCredits: "100",
    caps: {},
    previewEndsAt: null,
    autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
  } as CloudBillingPushRequest
  const res = await applyBillingPush(req, {}, deps)
  expect(res.status).toBe(200)
}

beforeEach(() => {
  resumed = []
})

afterAll(async () => {
  for (const id of orgs) {
    await sql`DELETE FROM kernel.routines WHERE org_id = ${id}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${id}`
    await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${id}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
  }
})

describe("one-shot routines on payment resumed", () => {
  test("only a due one-shot that never ran starts again", async () => {
    const orgId = await newOrg()
    const [owner] = await sql<{ id: string }[]>`INSERT INTO kernel.users (org_id, email, name)
      VALUES (${orgId}, ${`owner-${orgId.slice(0, 8)}@example.test`}, 'Owner') RETURNING id`
    const add = async (
      name: string,
      kind: string,
      runAt: string | null,
      lastRunAt: string | null,
      status = "active",
    ) => {
      const [row] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
        (org_id, owner_user_id, name, description, kind, cron, timezone, run_at, last_run_at, prompt, scopes,
         visibility, status, created_by_actor_type)
        VALUES (${orgId}, ${owner!.id}, ${name}, 'd', ${kind}, ${kind === "recurring" ? "0 8 * * *" : null}, ${kind === "recurring" ? "UTC" : null},
                ${runAt}, ${lastRunAt}, 'p', '{}', 'personal', ${status}, 'user') RETURNING id`
      return row!.id
    }
    const now = new Date("2026-11-05T12:00:00.000Z")
    const missed = await add("missed", "scheduled", "2026-11-05T11:00:00.000Z", null)
    await add("future", "scheduled", "2026-11-05T13:00:00.000Z", null)
    await add("done", "scheduled", "2026-11-05T10:00:00.000Z", "2026-11-05T10:00:01.000Z")
    await add("off", "scheduled", "2026-11-05T11:00:00.000Z", null, "paused_scope_mismatch")
    await add("cron", "recurring", null, null)
    // Came due during past_due: the tick ran, the credit gate refused, and it was paused with
    // lastRunAt set. It never ran, and a one-shot has no next tick to clear the pause.
    const paused = await add(
      "paused while past due",
      "scheduled",
      "2026-11-05T09:00:00.000Z",
      "2026-11-05T09:00:01.000Z",
      "paused_no_credits",
    )
    await add("paused, not due", "scheduled", "2026-11-05T13:00:00.000Z", null, "paused_no_credits")
    await add(
      "recurring, paused",
      "recurring",
      null,
      "2026-11-05T09:00:01.000Z",
      "paused_no_credits",
    )
    const started: string[] = []
    const n = await rerunMissedOneShots(orgId, async (id) => void started.push(id), now)
    expect(n).toBe(2)
    expect(started.sort()).toEqual([missed, paused].sort())
  })
})

describe("the push's own wiring (no test double for the resume)", () => {
  async function dueOneShot(orgId: string): Promise<string> {
    const [owner] = await sql<{ id: string }[]>`INSERT INTO kernel.users (org_id, email, name)
      VALUES (${orgId}, ${`owner-${orgId.slice(0, 8)}@example.test`}, 'Owner') RETURNING id`
    const [row] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, name, description, kind, cron, timezone, run_at, last_run_at, prompt, scopes,
       visibility, status, created_by_actor_type)
      VALUES (${orgId}, ${owner!.id}, 'due', 'd', 'scheduled', null, null, '2026-01-01T00:00:00.000Z', null,
              'p', '{}', 'personal', 'active', 'user') RETURNING id`
    return row!.id
  }
  const realPush = async (orgId: string, status: CloudBillingPushRequest["status"]) => {
    const res = await applyBillingPush(
      {
        orgId,
        version: version++,
        plan: "base",
        status,
        periodEnd: "2026-12-01T00:00:00.000Z",
        includedCredits: "100",
        caps: {},
        previewEndsAt: null,
        autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
      } as CloudBillingPushRequest,
      {},
    )
    expect(res.status).toBe(200)
  }

  test("the tick and the backfill wait out the other processes' status cache", async () => {
    const orgId = await newOrg()
    const routineId = await dueOneShot(orgId)
    await realPush(orgId, "suspended")
    const tick = spyOn(jobs, "enqueueAppJobForServer").mockResolvedValue("job")
    const backfill = spyOn(jobs, "enqueueAppJob").mockResolvedValue("job")
    try {
      await realPush(orgId, "active")
      const calls = tick.mock.calls.filter(([, job]) => job === "routine-tick")
      expect(calls).toHaveLength(1)
      expect(calls[0]![2]).toMatchObject({ routineId, orgId })
      expect(calls[0]![3]?.delay).toBeGreaterThan(STATUS_TTL_MS)
      const steps = backfill.mock.calls.filter(([, job]) => job === EMBEDDING_BACKFILL_JOB)
      expect(steps).toHaveLength(1)
      expect(steps[0]![3]?.delay).toBeGreaterThan(STATUS_TTL_MS)
    } finally {
      tick.mockRestore()
      backfill.mockRestore()
    }
  })

  test("a failed backfill start or enqueue does not take the other routines with it", async () => {
    const orgId = await newOrg()
    await dueOneShot(orgId)
    const [{ owner_user_id: owner }] = await sql<{ owner_user_id: string }[]>`
      SELECT owner_user_id FROM kernel.routines WHERE org_id = ${orgId}`
    await sql`INSERT INTO kernel.routines
      (org_id, owner_user_id, name, description, kind, cron, timezone, run_at, last_run_at, prompt, scopes,
       visibility, status, created_by_actor_type)
      VALUES (${orgId}, ${owner}, 'due 2', 'd', 'scheduled', null, null, '2026-01-01T00:00:00.000Z', null,
              'p', '{}', 'personal', 'active', 'user')`
    await realPush(orgId, "past_due")
    let ticks = 0
    const tick = spyOn(jobs, "enqueueAppJobForServer").mockImplementation(async () => {
      ticks += 1
      if (ticks === 1) throw new Error("queue down")
      return "job"
    })
    const backfill = spyOn(jobs, "enqueueAppJob").mockRejectedValue(new Error("queue down"))
    try {
      await realPush(orgId, "active")
      expect(ticks).toBe(2)
    } finally {
      tick.mockRestore()
      backfill.mockRestore()
    }
  })
})

describe("the backfill on payment resumed", () => {
  for (const from of ["past_due", "suspended"] as const) {
    test(`${from} → active starts it once for that org`, async () => {
      const orgId = await newOrg()
      const other = await newOrg()
      await push(orgId, "active")
      await push(other, "active")
      await push(orgId, from)
      expect(resumed).toEqual([])
      await push(orgId, "active")
      expect(resumed).toEqual([orgId])
      // A later push that keeps the org active starts nothing more.
      await push(orgId, "active")
      expect(resumed).toEqual([orgId])
    })
  }

  test("a first push, active → active and active → past_due start nothing", async () => {
    const orgId = await newOrg()
    await push(orgId, "active")
    await push(orgId, "active")
    await push(orgId, "past_due")
    expect(resumed).toEqual([])
  })

  test("a stale push that loses changes nothing", async () => {
    const orgId = await newOrg()
    await push(orgId, "past_due")
    const stale = {
      orgId,
      version: 0,
      plan: "base",
      status: "active",
      periodEnd: "2026-12-01T00:00:00.000Z",
      includedCredits: "100",
      caps: {},
      previewEndsAt: null,
      autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
    } as CloudBillingPushRequest
    const res = await applyBillingPush(stale, {}, deps)
    expect(res.reply).toMatchObject({ applied: false })
    expect(resumed).toEqual([])
  })
})
