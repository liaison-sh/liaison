// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Why a shared project shows no hours: a project that bills by milestone says so, a closed
// hours share says nothing at all, and the answer never reaches another company's people.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows, sql } from "~/db"
import { withPortalContext } from "~/db/portal-rls"
import { createPortalSession } from "~/modules/auth/auth"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createDoorWorld, type DoorWorld, dropDoorWorld, insertShare } from "./fixture"
import { dropReadsWorld, insertBilledLine, insertProject, type ProjectSeed } from "./reads-world"

let w: DoorWorld
let fixed: ProjectSeed
let hourly: ProjectSeed
let off: ProjectSeed
const tokens: Record<string, string> = {}

async function project(id: string, userId = w.clientA.userId) {
  tokens[userId] ??= (await createPortalSession(userId, w.orgId)).accessToken
  return app.request(`/api/portal/projects/${id}`, {
    headers: { Authorization: `Bearer ${tokens[userId]}` },
  })
}

async function body(id: string) {
  const res = await project(id)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { hours: unknown; hoursNote: unknown } }).data
}

async function basisAs(userId: string, projectId: string): Promise<string | null> {
  return withPortalContext({ orgId: w.orgId, userId }, async (tx) => {
    const [r] = extractRows<{ note: string | null }>(
      await tx.execute(drizzleSql`SELECT portal.project_hours_basis(${projectId}::uuid) AS note`),
    )
    return r?.note ?? null
  })
}

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  fixed = await insertProject(w, { company_id: w.companyA, basis: "fixed", name: "Fixed" })
  hourly = await insertProject(w, { company_id: w.companyA, basis: "hourly", name: "Hourly" })
  off = await insertProject(w, {
    company_id: w.companyA,
    basis: "fixed",
    time_budgets_on: false,
    name: "Off",
  })
  for (const p of [fixed, hourly, off]) {
    await insertShare(w, { company_id: w.companyA, kind: "project_progress", object_id: p.id })
  }
  await insertShare(w, { company_id: w.companyB, kind: "project_progress", object_id: fixed.id })
  await insertBilledLine(w, hourly.id, 60)
}, 180_000)

afterAll(async () => {
  if (w) {
    await dropReadsWorld(w)
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("why a shared project shows no hours", () => {
  it("a closed hours share says nothing; an open one on a milestone project says it bills by milestone", async () => {
    expect(await body(fixed.id)).toMatchObject({ hours: null, hoursNote: null })
    for (const p of [fixed, hourly, off]) {
      await insertShare(w, { company_id: w.companyA, kind: "project_hours", object_id: p.id })
    }
    expect(await body(fixed.id)).toMatchObject({ hours: null, hoursNote: "by_milestone" })
    const h = await body(hourly.id)
    expect(h.hours).toMatchObject({ kind: "billed", usedMinutes: 60 })
    expect(h.hoursNote).toBeNull()
    // Time and budgets off: no hours and no reason, as with a closed share.
    expect(await body(off.id)).toMatchObject({ hours: null, hoursNote: null })
  })

  it("another company's people never learn how a project bills, even with a share named on it", async () => {
    await insertShare(w, { company_id: w.companyB, kind: "project_hours", object_id: fixed.id })
    expect(await basisAs(w.clientB.userId, fixed.id)).toBeNull()
    expect(await basisAs(w.clientA.userId, fixed.id)).toBe("by_milestone")
    expect((await project(fixed.id, w.clientB.userId)).status).toBe(404)
  })

  it("closing the hours share takes the reason away on the next read", async () => {
    await sql.unsafe(
      `UPDATE kernel.portal_shares SET closed_at = now()
        WHERE org_id = '${w.orgId}' AND company_id = '${w.companyA}' AND kind = 'project_hours'
          AND object_id = '${fixed.id}' AND closed_at IS NULL`,
    )
    expect(await body(fixed.id)).toMatchObject({ hours: null, hoursNote: null })
  })
})
