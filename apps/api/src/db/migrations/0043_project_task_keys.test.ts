// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins the invariants migration 0043 establishes: every project has a short
// uppercase key (format-checked by the DB CHECK constraint), unique per org;
// every task has a per-project sequential number; `next_task_number` tracks
// one past the highest allocated number. Seeds through the real service
// (createProject/createTask), which is what maintains these invariants going
// forward — this is the regression guard that a future change to either
// doesn't quietly violate them.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/

let orgId: string
let userId: string
let actor: UserContext

beforeAll(async () => {
  await acquireTestLock()
  const slug = `migration-0043-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), '0043 Migration Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`0043-${Date.now()}@t.co`}, 'Migration User', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = u!.id
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["projects:projects:read", "projects:projects:write", "projects:tasks:write"],
    dimensionGrants: {},
  }
})

afterAll(releaseTestLock)

describe("0043_project_task_keys invariants", () => {
  it("gives every seeded project a key matching the format, unique within the org", async () => {
    const names = [`Alpha ${Date.now()}`, `Beta ${Date.now()}`, `Alpha ${Date.now()}`]
    const projects = await Promise.all(
      names.map((name) =>
        withRlsContext(actor, (tx) => createProject({ tx, orgId, actor, input: { name } })),
      ),
    )
    for (const p of projects) {
      expect(p.key).toMatch(KEY_RE)
    }
    const keys = projects.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("allocates per-project task numbers as an exact contiguous 1..N run", async () => {
    const project = await withRlsContext(actor, (tx) =>
      createProject({ tx, orgId, actor, input: { name: `Contiguous ${Date.now()}` } }),
    )
    const status = project.statuses.find((s) => !s.terminal)!.id
    const N = 6
    const tasks = []
    for (let i = 0; i < N; i++) {
      tasks.push(
        await withRlsContext(actor, (tx) =>
          createTask({
            tx,
            orgId,
            actor,
            input: { projectId: project.id, statusId: status, title: `task ${i}` },
          }),
        ),
      )
    }
    const numbers = tasks.map((t) => t.number).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(numbers).toEqual(Array.from({ length: N }, (_, i) => i + 1))

    const rows = extractRows<{ next_task_number: number }>(
      await db.execute(drizzleSql`
        SELECT next_task_number FROM app_projects.projects WHERE id = ${project.id}::uuid
      `),
    )
    expect(rows[0]?.next_task_number).toBe(N + 1)
  })

  it("rejects a project row whose key does not match the format (DB CHECK)", async () => {
    const [proj] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id FROM app_projects.projects WHERE org_id = ${orgId}::uuid LIMIT 1
      `),
    )
    expect(proj).toBeTruthy()
    let threw = false
    try {
      await db.execute(drizzleSql`
        UPDATE app_projects.projects SET key = 'not-a-key' WHERE id = ${proj!.id}::uuid
      `)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
