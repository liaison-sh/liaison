// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/agent/routines/entity-runs: the runs fired on one record, served only to a caller who
// can read that record through its app's declared flow record reader, and only what the record's
// view draws (no error, notes, outputs other than a wait's deadline, pause state or flow context).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { app } from "~/app"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { routineRuns, routines as routinesTbl } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { signAccessToken } from "~/modules/auth/jwt"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const PROJECTS = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]
const ROUTINES = ["kernel:routines:read", "kernel:routines:write"]

let orgId = ""
let otherOrgId = ""
let reader: UserContext
let noRead: UserContext
let taskId = ""
let otherOrgTaskId = ""

const mkUser = (org: string, name: string) =>
  seedUserRow({
    orgId: org,
    email: `${name}-${randomUUID()}@test.com`,
    name,
    status: "active",
    passwordHash: "hash",
    authVersion: 1,
    permissionVersion: 1,
  })

const token = (u: UserContext) =>
  signAccessToken(
    {
      userId: u.userId,
      orgId: u.orgId,
      name: "Tester",
      authVersion: 1,
      permissionVersion: 1,
      scopes: u.scopes,
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )

async function taskIn(owner: UserContext): Promise<string> {
  return withRlsContext(owner, async (tx) => {
    const p = await createProject({
      tx,
      orgId: owner.orgId,
      actor: owner,
      input: { name: `runs-${randomUUID().slice(0, 8)}`, statuses: [{ label: "Todo" }] },
    })
    const t = await createTask({
      tx,
      orgId: owner.orgId,
      actor: owner,
      input: { projectId: p.id, title: "Ship the amp" },
    })
    return t.id
  })
}

async function routineWithRun(ownerUserId: string, entityId: string, triggerLabel: string) {
  const [r] = await withPrivilegedDb(orgId, "entity-runs-seed", (tx) =>
    tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId,
        name: `entity-runs-${randomUUID().slice(0, 6)}`,
        title: "Chase the task",
        description: "x",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: [],
        createdByUserId: ownerUserId,
        createdByActorType: "user",
      })
      .returning(),
  )
  await withPrivilegedDb(orgId, "entity-runs-run", (tx) =>
    tx.insert(routineRuns).values({
      orgId,
      routineId: r!.id,
      ranAt: new Date(),
      status: "waiting",
      trigger: "event",
      triggerLabel,
      eventEntityId: entityId,
      error: "upstream said no",
      pauseState: { secret: true } as never,
      flowContext: { event: { data: { secret: true } } } as never,
      steps: [
        { id: "act", type: "action", state: "done", note: "a private note", output: { x: 1 } },
        {
          id: "wait",
          type: "wait",
          state: "waiting",
          output: { deadline: "2026-12-01T09:00:00.000Z", extra: "hidden" },
        },
      ] as never,
    }),
  )
  return r!.id
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = await seedOrgRow({ name: "Entity Runs Org", slug: `entity-runs-${randomUUID()}` })
  otherOrgId = await seedOrgRow({
    name: "Entity Runs Other",
    slug: `entity-runs-o-${randomUUID()}`,
  })
  const base = { actorType: "user" as const, dimensionGrants: { "*": ["*"] } }
  reader = {
    ...base,
    orgId,
    userId: await mkUser(orgId, "Reader"),
    scopes: [...ROUTINES, ...PROJECTS],
  }
  noRead = { ...base, orgId, userId: await mkUser(orgId, "No Read"), scopes: [...ROUTINES] }
  const otherOwner: UserContext = {
    ...base,
    orgId: otherOrgId,
    userId: await mkUser(otherOrgId, "Other Owner"),
    scopes: [...ROUTINES, ...PROJECTS],
  }
  await ensureAppsForOrg(orgId, {})
  await ensureAppsForOrg(otherOrgId, {})
  taskId = await taskIn(reader)
  otherOrgTaskId = await taskIn(otherOwner)
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

const get = async (u: UserContext, query: string) =>
  app.request(`/api/agent/routines/entity-runs?${query}`, {
    headers: { Authorization: `Bearer ${await token(u)}` },
  })

describe("GET /api/agent/routines/entity-runs", () => {
  it("refuses a missing or overlong entityId, and a family with no declared flow record", async () => {
    expect((await get(reader, "app=projects&entity=task")).status).toBe(400)
    expect((await get(reader, `app=projects&entity=task&entityId=${"x".repeat(201)}`)).status).toBe(
      400,
    )
    expect((await get(reader, `entityId=${taskId}`)).status).toBe(400)
    expect((await get(reader, `app=nope&entity=task&entityId=${taskId}`)).status).toBe(400)
  })

  it("serves a readable record's runs with only what the view draws", async () => {
    const routineId = await routineWithRun(reader.userId, taskId, "projects.task.status_changed")
    // A run of another family on the same id is not this record's.
    await routineWithRun(reader.userId, taskId, "tickets.ticket.created")
    const res = await get(reader, `app=projects&entity=task&entityId=${taskId}`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> }
    expect(data).toHaveLength(1)
    const run = data[0]!
    expect(run.routineId).toBe(routineId)
    expect(run.routineTitle).toBe("Chase the task")
    expect(run.status).toBe("waiting")
    expect(Object.keys(run).sort()).toEqual(
      [
        "id",
        "ranAt",
        "routineId",
        "routineName",
        "routineTitle",
        "startedAt",
        "status",
        "steps",
      ].sort(),
    )
    expect(run.steps).toEqual([
      { id: "act", type: "action", state: "done" },
      {
        id: "wait",
        type: "wait",
        state: "waiting",
        output: { deadline: "2026-12-01T09:00:00.000Z" },
      },
    ])
    expect(JSON.stringify(run)).not.toContain("upstream said no")
    expect(JSON.stringify(run)).not.toContain("secret")
  })

  it("serves nothing to a caller who cannot read the record, even on their own routine", async () => {
    await routineWithRun(noRead.userId, taskId, "projects.task.status_changed")
    const res = await get(noRead, `app=projects&entity=task&entityId=${taskId}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([])
  })

  it("serves nothing for another organisation's record", async () => {
    await routineWithRun(reader.userId, otherOrgTaskId, "projects.task.status_changed")
    const res = await get(reader, `app=projects&entity=task&entityId=${otherOrgTaskId}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([])
  })
})
