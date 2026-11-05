// SPDX-License-Identifier: FSL-1.1-ALv2
// Slice C (exhaustive sweep): prove the count-driven loop the system prompt
// prescribes actually CONVERGES to zero and is IDEMPOTENT, using the REAL
// tools (no model). This is the deterministic backstop behind the soft,
// count-pulls-continuation behavior: a routine that reads totalCount(terminal:
// false), processes one unfinished task per step, and re-reads the count will
// (a) drive the count monotonically to 0 in exactly N steps, and (b) re-running
// after zero is a no-op — never double-acting on an already-terminal task.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, listProjectTasks } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"

let orgId: string
let actor: UserContext
let projectId: string
let openStatusId: string
let doneStatusId: string

const N = 9

beforeAll(async () => {
  const orgRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Sweep Conv', ${`sweep-conv-${Date.now()}-${Math.random()}`}) RETURNING id
    `),
  )
  orgId = orgRows[0]!.id
  const userRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`sc-${Date.now()}@xp.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `),
  )
  actor = {
    actorType: "user",
    userId: userRows[0]!.id,
    orgId,
    scopes: [
      "projects:projects:read",
      "projects:projects:write",
      "projects:tasks:read",
      "projects:tasks:write",
      "kernel:threads:read",
      "kernel:threads:write",
    ],
    dimensionGrants: { "*": ["*"] },
  }
  await withRlsContext(actor, async (tx) => {
    const p = await createProject({ tx, orgId, actor, input: { name: "Backlog" } })
    projectId = p.id
    openStatusId = p.statuses.find((s) => !s.terminal)!.id
    doneStatusId = p.statuses.find((s) => s.terminal)!.id
    for (let i = 0; i < N; i++)
      await createTask({
        tx,
        orgId,
        actor,
        input: { projectId, statusId: openStatusId, title: `t-${i}` },
      })
  })
})

// The loop a sweep agent runs: read remaining count → process one → repeat.
async function remaining(): Promise<number> {
  return withRlsContext(actor, async (tx) => {
    const r = await listProjectTasks({
      tx,
      orgId,
      projectId,
      terminal: false,
      countOnly: true,
    } as never)
    return r.totalCount
  })
}
async function processOne(): Promise<boolean> {
  return withRlsContext(actor, async (tx) => {
    const page = await listProjectTasks({
      tx,
      orgId,
      projectId,
      terminal: false,
      limit: 1,
    } as never)
    const task = page.items[0]
    if (!task) return false
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("tasks")} SET status_id = ${doneStatusId}::uuid, updated_at = now()
      WHERE id = ${(task as { id: string }).id}::uuid
    `)
    return true
  })
}

describe("exhaustive sweep — convergence + idempotency", () => {
  it("the count-driven loop drives the work-list monotonically to zero in exactly N steps", async () => {
    expect(await remaining()).toBe(N)
    let processed = 0
    let prev = N
    // Hard cap well above N proves termination (no infinite loop).
    for (let guard = 0; guard < N + 5; guard++) {
      const left = await remaining()
      if (left === 0) break
      // Monotonic non-increase — the count never grows mid-sweep.
      expect(left).toBeLessThanOrEqual(prev)
      prev = left
      const did = await processOne()
      expect(did).toBe(true)
      processed++
      // Each processed item leaves the predicate → count drops by exactly one.
      expect(await remaining()).toBe(left - 1)
    }
    expect(processed).toBe(N)
    expect(await remaining()).toBe(0)
  })

  it("re-running after zero is a no-op — no item to double-process", async () => {
    expect(await remaining()).toBe(0)
    // The predicate is empty, so a fresh pass finds nothing to act on.
    expect(await processOne()).toBe(false)
    expect(await remaining()).toBe(0)
  })
})
