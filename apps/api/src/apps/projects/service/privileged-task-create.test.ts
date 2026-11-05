// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A privileged transaction that creates a task (an import, an app's event
// handler) names who it writes for: the task number's scope check reads that
// actor's scopes. Without one the context is empty and the check refuses, on
// every connection alike (migration 0210, db/privileged.ts setPrivilegedContext).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { importServiceClient } from "~/modules/imports/service-client"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let operator: UserContext
let projectId = ""
const tag = () => crypto.randomUUID().slice(0, 8)

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `priv-task-${tag()}`, name: "Privileged Task" })).orgId
  const userId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-priv-1!",
      role: "admin",
    })
  ).userId
  operator = { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} }
  projectId = (
    await withPrivilegedDb(orgId, "test", (tx) =>
      createProject({
        tx: importServiceClient(tx),
        orgId,
        actor: operator,
        input: { name: `Privileged ${tag()}` },
      }),
    )
  ).id
}, 120_000)
afterAll(releaseTestLock)

function create(opts: Parameters<typeof withPrivilegedDb>[3]) {
  return withPrivilegedDb(
    orgId,
    "test-system-task",
    (tx) =>
      createTask({
        tx: importServiceClient(tx),
        orgId,
        actor: operator,
        input: { projectId, title: `System ${tag()}` },
      }),
    opts,
  )
}

/** The database's refusal of a create (the driver error is the query's `cause`). */
async function refusal(opts: Parameters<typeof withPrivilegedDb>[3]): Promise<string> {
  try {
    await create(opts)
    return "created"
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined
    return cause instanceof Error ? cause.message : String(err)
  }
}

describe("a privileged task create", () => {
  it("succeeds for an app actor holding projects:tasks:write", async () => {
    const task = await create({ pool: "jobs", actor: { scopes: ["projects:tasks:write"] } })
    expect(task.id).toBeDefined()
  })

  it("is refused for an actor without it, and with no actor at all", async () => {
    expect(await refusal({ pool: "jobs", actor: { scopes: ["ci:releases:write"] } })).toMatch(
      /insufficient_scope: projects:tasks:write/,
    )
    expect(await refusal({ pool: "jobs" })).toMatch(/insufficient_scope: projects:tasks:write/)
  })
})
