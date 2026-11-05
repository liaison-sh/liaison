// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { resolveAssignee, resolveProjectId } from "~/apps/projects/service/resolve"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let marieId: string
let actor: UserContext

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-http-int-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'HTTP Int Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const insertUser = async (name: string): Promise<string> => {
    const [u] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid,
                ${`${name.toLowerCase()}-${Date.now()}-${Math.random()}@test.com`}, ${name},
                'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    return u!.id
  }
  userId = await insertUser("Owner")
  marieId = await insertUser("Marie")
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }
})

afterAll(async () => {
  await releaseTestLock()
})

describe("projects.http.integration", () => {
  it("projects.tools.create-assignee-resolution", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `Assign-${Date.now()}` } }),
    )
    const projectId = await withRlsContext(actor, async (tx) =>
      resolveProjectId(tx, orgId, { projectId: project.id }),
    )
    const assigneeId = await withRlsContext(actor, async (tx) =>
      resolveAssignee(tx, orgId, { assigneeName: "Marie" }),
    )
    const task = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId, title: "Investigate", assigneeId },
      }),
    )
    expect(task.assigneeId).toBe(marieId)
  })
})
