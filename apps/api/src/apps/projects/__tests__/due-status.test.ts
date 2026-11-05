// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T9: a single "due status" definition shared by the attention feed and the
// task list filters. This locks two things:
//   1. The pure `dueBucket()` classifier and the `dueBucketSql()` Postgres
//      fragment agree on every corner (past/today/boundary/beyond/null date,
//      crossed with terminal/non-terminal).
//   2. The attention feed's own policy (excluding blocked tasks) stays a
//      LAYER ON TOP of due semantics, not folded into them: a blocked overdue
//      task is still "overdue" by the pure classifier but absent from
//      computeAttentionItems.
// Fails without the fix: before this change there was no shared `dueBucket`/
// `dueBucketSql` at all (new module), and attention.ts computed its own
// ad hoc date predicates that this test pins against the shared definition.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { computeAttentionItems } from "~/apps/projects/attention"
import { projectsRel } from "~/apps/projects/schema-refs"
import { createProject } from "~/apps/projects/service/create-project"
import { DUE_SOON_DAYS, dueBucket, dueBucketSql } from "~/apps/projects/service/due-status"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

let orgId: string
let meId: string
let actor: UserContext
let projectId: string
let openStatusId: string
let doneStatusId: string
let today: string

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-due-status-${Date.now()}-${Math.random()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Due Status Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [me] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`ds-${Date.now()}@test.com`}, 'Me', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  meId = me!.id
  actor = {
    actorType: "user",
    userId: meId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }

  const [row] = extractRows<{ today: string }>(
    await db.execute(drizzleSql`SELECT CURRENT_DATE::text AS today`),
  )
  today = row!.today

  await withRlsContext(actor, async (tx) => {
    const p = await createProject({ tx, orgId, actor, input: { name: "Due status board" } })
    projectId = p.id
    openStatusId = p.statuses.find((s) => !s.terminal)!.id
    doneStatusId = p.statuses.find((s) => s.terminal)!.id
  })
})

afterAll(async () => {
  await releaseTestLock()
})

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

describe("dueBucket / dueBucketSql agreement", () => {
  const offsets: Array<number | null> = [-1, 0, 1, DUE_SOON_DAYS, DUE_SOON_DAYS + 1, null]

  for (const offset of offsets) {
    for (const terminal of [true, false]) {
      const label = `offset=${offset === null ? "null" : offset} terminal=${terminal}`

      it(`pure bucket and SQL bucket agree: ${label}`, async () => {
        const dueDate = offset === null ? null : addDays(today, offset)
        const title = `due-status-${offset ?? "null"}-${terminal}-${Math.random()}`
        const statusId = terminal ? doneStatusId : openStatusId
        await withRlsContext(actor, async (tx) => {
          await createTask({
            tx,
            orgId,
            actor,
            input: { projectId, statusId, title, assigneeId: meId, dueDate },
          })
        })

        const pureBucket = dueBucket(dueDate, terminal, today)

        const sqlRows = extractRows<{ bucket: string }>(
          await withRlsContext(actor, async (tx) =>
            tx.execute(drizzleSql`
              SELECT ${dueBucketSql("t", "s")} AS bucket
              FROM ${projectsRel("tasks")} t
              JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
              WHERE t.org_id = ${orgId}::uuid AND t.title = ${title}
            `),
          ),
        )
        expect(sqlRows[0]!.bucket).toBe(pureBucket)
      })
    }
  }
})

describe("attention overdue still excludes blocked tasks (blocked is a feed policy, not a due bucket)", () => {
  it("a blocked overdue task is `overdue` by dueBucket but absent from computeAttentionItems", async () => {
    const title = `blocked-overdue-${Math.random()}`
    const dueDate = addDays(today, -3)
    await withRlsContext(actor, async (tx) => {
      await createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId,
          statusId: openStatusId,
          title,
          assigneeId: meId,
          dueDate,
          blocked: true,
        },
      })
    })

    expect(dueBucket(dueDate, false, today)).toBe("overdue")

    const items = await withRlsContext(actor, async (tx) => computeAttentionItems(tx, orgId, meId))
    const overdueSummaries = items.filter((i) => i.kind === "task_overdue")
    expect(overdueSummaries.some((i) => i.summary === title)).toBe(false)
  })
})
