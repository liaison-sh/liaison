// SPDX-License-Identifier: FSL-1.1-ALv2
// Slice B (exhaustive-sweep substrate): includeTotal / countOnly / terminal
// filter on listProjectTasks (the tasks_byProject tool). A routine sweeping
// "finish every unfinished task in project X" lists with terminal:false +
// includeTotal, gets a measured remaining count, and as each task is moved to a
// terminal status it leaves the set and the count drops — so the agent cannot
// lose count. Server COUNT over the SAME filter, never a page-size tally.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, listProjectTasks } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"

// Hermeticity (module-mock poisoning), defense-in-depth: a neighbouring file
// (`modules/apps/sandbox/rpc-bridge.k4.test.ts`) calls
// `mock.module("~/modules/apps/execute-tool", ...)`. That polluter is now
// spread-complete + restores the real module in `afterAll`, which removes the
// MISSING-EXPORT class. But its `executeToolCore` OVERRIDE still leaks to any
// consumer whose execute-tool binding resolves at MODULE SCOPE: Bun evaluates
// all files' module-scope code (including a plain `await import(...)`) BEFORE
// any `afterAll` runs, so a normal import here would still capture k4's stubbed
// `executeToolCore` (returning its leftover `nextEnvelope` = `{ data: null }`).
// A query-string-suffixed specifier is a DISTINCT module key that Bun's mock
// registry never matches, so it loads a FRESH, unmocked copy of execute-tool
// regardless of evaluation order — recovering the genuine dispatch path.
const { executeTool } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-total`
)) as typeof import("~/modules/apps/execute-tool")

import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let actor: UserContext
let projectId: string
let openStatusId: string
let doneStatusId: string

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

beforeAll(async () => {
  await acquireTestLock()
  const orgRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Proj Total', ${`proj-total-${Date.now()}-${Math.random()}`}) RETURNING id
    `),
  )
  orgId = orgRows[0]!.id
  const userRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`pt-${Date.now()}@xp.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `),
  )
  userId = userRows[0]!.id
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }

  await withRlsContext(actor, async (tx) => {
    const p = await createProject({ tx, orgId, actor, input: { name: "Sweep me" } })
    projectId = p.id
    openStatusId = p.statuses.find((s) => !s.terminal)!.id
    doneStatusId = p.statuses.find((s) => s.terminal)!.id
    // 5 unfinished, 2 already done.
    for (let i = 0; i < 5; i++)
      await createTask({
        tx,
        orgId,
        actor,
        input: { projectId, statusId: openStatusId, title: `open-${i}` },
      })
    for (let i = 0; i < 2; i++)
      await createTask({
        tx,
        orgId,
        actor,
        input: { projectId, statusId: doneStatusId, title: `done-${i}` },
      })
  })
  await ensureAppsForOrg(orgId, {})
})

afterAll(async () => {
  await releaseTestLock()
})

describe("listProjectTasks — totalCount (always-on) / countOnly / terminal filter", () => {
  it("terminal:false totalCount counts every UNFINISHED task over the page", async () => {
    await withRlsContext(actor, async (tx) => {
      const res = await listProjectTasks({
        tx,
        orgId,
        projectId,
        terminal: false,
        limit: 2,
      } as never)
      expect(res.items.length).toBe(2) // page capped
      expect(res.totalCount).toBe(5) // but the count is the full set
    })
  })

  it("terminal:true counts only the finished tasks", async () => {
    await withRlsContext(actor, async (tx) => {
      const res = await listProjectTasks({
        tx,
        orgId,
        projectId,
        terminal: true,
        countOnly: true,
      } as never)
      expect(res.totalCount).toBe(2)
      expect(res.items).toEqual([])
    })
  })

  it("the count tracks the predicate: moving one task to a terminal status drops the unfinished total", async () => {
    const before = await withRlsContext(actor, async (tx) =>
      listProjectTasks({ tx, orgId, projectId, terminal: false, countOnly: true } as never),
    )
    expect(before.totalCount).toBe(5)

    // Move one unfinished task to the terminal status (simulates the sweep's per-item action).
    await withRlsContext(actor, async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("tasks")} SET status_id = ${doneStatusId}::uuid, updated_at = now()
        WHERE id = (
          SELECT id FROM ${projectsRel("tasks")}
          WHERE project_id = ${projectId}::uuid AND status_id = ${openStatusId}::uuid
          LIMIT 1
        )
      `)
    })

    const after = await withRlsContext(actor, async (tx) =>
      listProjectTasks({ tx, orgId, projectId, terminal: false, countOnly: true } as never),
    )
    expect(after.totalCount).toBe(4)
  })

  it("surfaces totalCount through the projects:tasks_byProject tool (manifest → rpc bridge)", async () => {
    const out = await executeTool({
      toolName: "projects:tasks_byProject",
      orgId,
      actor: actor as ActorContext,
      params: { projectId, terminal: false, limit: 2 },
    })
    const data = out.data as { items: unknown[]; totalCount?: number }
    expect(typeof data.totalCount).toBe("number")
    expect(data.items.length).toBeLessThanOrEqual(2)
    expect(data.totalCount).toBeGreaterThanOrEqual(data.items.length)
  })
})
