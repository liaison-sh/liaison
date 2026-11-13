// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A member's data subject export carries the time they entered, their away days and their days
// per week, and nothing of a colleague's: not their rows, not who is next in line, not who set
// a range or changed an entry.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { MEMBER_SECTIONS, readMemberSections } from "~/modules/export/member-data-subject-bundle"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let admin: minimal.Session
let ana: minimal.Session
let leo: minimal.Session

async function call<T>(method: string, input: unknown): Promise<T> {
  const a: UserContext = {
    actorType: "user",
    userId: leo.userId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
  return withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  admin = await minimal.adminSession(orgId)
  ana = await minimal.session(orgId, { role: "member" })
  leo = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  const p = await call<{ id: string }>("projects_createProject", { name: "Maison Delorme" })
  const t = await call<{ id: string }>("projects_createTask", { projectId: p.id, title: "Layouts" })
  await db.execute(drizzleSql`
    INSERT INTO app_projects.task_time (org_id, task_id, project_id, user_id, work_date, minutes, entered_via, changed_by)
    VALUES (${orgId}::uuid, ${t.id}::uuid, ${p.id}::uuid, ${ana.userId}::uuid, '2026-10-05', 150, 'field', ${leo.userId}::uuid),
           (${orgId}::uuid, ${t.id}::uuid, ${p.id}::uuid, ${leo.userId}::uuid, '2026-10-05', 999, 'agent', NULL)`)
  await db.execute(drizzleSql`
    INSERT INTO kernel.away_ranges (org_id, user_id, starts_on, ends_on, source, next_in_line_id, set_by)
    VALUES (${orgId}::uuid, ${ana.userId}::uuid, '2026-12-21', '2026-12-31', 'lead', ${leo.userId}::uuid, ${leo.userId}::uuid),
           (${orgId}::uuid, ${leo.userId}::uuid, '2026-08-01', '2026-08-15', 'said', NULL, ${leo.userId}::uuid)`)
  await db.execute(drizzleSql`
    INSERT INTO app_projects.person_capacity (org_id, user_id, days_per_week, updated_by)
    VALUES (${orgId}::uuid, ${ana.userId}::uuid, 4, ${leo.userId}::uuid)`)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("a member's time in their data subject export", () => {
  it("a person's export holds their own time and away ranges and nothing of others", async () => {
    const sections = MEMBER_SECTIONS.filter((s) =>
      ["ownTaskTime", "awayRanges", "daysPerWeek"].includes(s.key),
    )
    expect(sections).toHaveLength(3)
    const out = await withRlsContext(
      { actorType: "user", userId: admin.userId, orgId, scopes: ["*"], dimensionGrants: {} },
      (tx) => readMemberSections(tx, { orgId, subjectUserId: ana.userId }, sections),
    )
    expect(out.ownTaskTime?.rows).toMatchObject([
      {
        work_date: "2026-10-05",
        minutes: 150,
        entered_via: "field",
        task: "Layouts",
        project: "Maison Delorme",
        changed_by_someone_else: true,
      },
    ])
    expect(out.awayRanges?.rows).toMatchObject([
      {
        starts_on: "2026-12-21",
        ends_on: "2026-12-31",
        source: "lead",
        set_by_someone_else: true,
      },
    ])
    expect(out.daysPerWeek?.rows).toMatchObject([{ days_per_week: 4 }])
    const text = JSON.stringify(out)
    expect(text).not.toContain(leo.userId)
    expect(text).not.toContain("999")
    expect(text).not.toContain("2026-08-01")
  })
})
