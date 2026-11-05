// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { resolveTaskRef } from "~/apps/projects/service/resolve"
import { ProjectsServiceError } from "~/apps/projects/service/statuses"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let otherOrgId: string
let userId: string
let otherUserId: string
let actor: UserContext
let otherActor: UserContext

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-task-keys-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Task Keys Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const otherSlug = `projects-task-keys-other-${Date.now()}`
  const [otherOrg] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Task Keys Other Org', ${otherSlug}) RETURNING id
    `),
  )
  otherOrgId = otherOrg!.id

  const insertUser = async (oid: string, email: string): Promise<string> => {
    const [u] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${oid}::uuid, ${email}, 'Task Keys User', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    return u!.id
  }
  userId = await insertUser(orgId, `task-keys-${Date.now()}@t.co`)
  otherUserId = await insertUser(otherOrgId, `task-keys-other-${Date.now()}@t.co`)

  const scopes = [
    "projects:projects:read",
    "projects:projects:write",
    "projects:tasks:read",
    "projects:tasks:write",
  ]
  actor = { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  otherActor = {
    actorType: "user",
    userId: otherUserId,
    orgId: otherOrgId,
    scopes,
    dimensionGrants: {},
  }
})

afterAll(releaseTestLock)

describe("task keys", () => {
  it("allocates contiguous per-project task numbers under concurrent creation", async () => {
    const [projectA, projectB] = await Promise.all([
      withRlsContext(actor, (tx) =>
        createProject({ tx, orgId, actor, input: { name: `ConcurrentA-${Date.now()}` } }),
      ),
      withRlsContext(actor, (tx) =>
        createProject({ tx, orgId, actor, input: { name: `ConcurrentB-${Date.now()}` } }),
      ),
    ])
    const statusA = projectA.statuses.find((s) => !s.terminal)!.id
    const statusB = projectB.statuses.find((s) => !s.terminal)!.id

    const createOnA = () =>
      withRlsContext(actor, (tx) =>
        createTask({
          tx,
          orgId,
          actor,
          input: { projectId: projectA.id, statusId: statusA, title: "task A" },
        }),
      )
    const createOnB = () =>
      withRlsContext(actor, (tx) =>
        createTask({
          tx,
          orgId,
          actor,
          input: { projectId: projectB.id, statusId: statusB, title: "task B" },
        }),
      )

    const [tasksA, tasksB] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, createOnA)),
      Promise.all(Array.from({ length: 5 }, createOnB)),
    ])

    const numbersA = tasksA.map((t) => t.number).sort((a, b) => (a ?? 0) - (b ?? 0))
    const numbersB = tasksB.map((t) => t.number).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(numbersA).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(numbersB).toEqual([1, 2, 3, 4, 5])
  })

  it("resolves a task by its ERB-12 key", async () => {
    const project = await withRlsContext(actor, (tx) =>
      createProject({ tx, orgId, actor, input: { name: `ResolveKey-${Date.now()}`, key: "RKY" } }),
    )
    const status = project.statuses.find((s) => !s.terminal)!.id
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: status, title: "resolvable task" },
      }),
    )
    const displayKey = `RKY-${task.number}`
    await withRlsContext(actor, async (tx) => {
      const resolved = await resolveTaskRef(tx, orgId, displayKey)
      expect(resolved).toBe(task.id)
    })
  })

  it("creates a task for a member scoped to tasks write only, not projects write", async () => {
    const project = await withRlsContext(actor, (tx) =>
      createProject({ tx, orgId, actor, input: { name: `MemberScope-${Date.now()}` } }),
    )
    const status = project.statuses.find((s) => !s.terminal)!.id
    const memberActor: UserContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"],
      dimensionGrants: {},
    }
    const task = await withRlsContext(memberActor, (tx) =>
      createTask({
        tx,
        orgId,
        actor: memberActor,
        input: { projectId: project.id, statusId: status, title: "member created task" },
      }),
    )
    expect(task.number).toBeGreaterThanOrEqual(1)
  })

  it("refuses a key belonging to another org (not found, no cross-org read)", async () => {
    const project = await withRlsContext(otherActor, (tx) =>
      createProject({
        tx,
        orgId: otherOrgId,
        actor: otherActor,
        input: { name: `OtherOrgProj-${Date.now()}`, key: "OTH" },
      }),
    )
    const status = project.statuses.find((s) => !s.terminal)!.id
    const task = await withRlsContext(otherActor, (tx) =>
      createTask({
        tx,
        orgId: otherOrgId,
        actor: otherActor,
        input: { projectId: project.id, statusId: status, title: "other org task" },
      }),
    )
    const displayKey = `OTH-${task.number}`
    await withRlsContext(actor, async (tx) => {
      await expect(resolveTaskRef(tx, orgId, displayKey)).rejects.toThrow(ProjectsServiceError)
    })
  })
})
