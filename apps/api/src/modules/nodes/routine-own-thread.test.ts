// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Walk N4: a routine whose output thread is the one it made itself (type
// "routine", the owner seated, the agent not) could not be edited at all: the
// form sends the destination back unchanged and the update refused it as a
// thread the owner agent has no seat in, so runs_on never changed.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"

const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async () => "job-id",
  upsertJobScheduler: async () => undefined,
  removeScheduledJob: async () => undefined,
  removeAppJob: async () => undefined,
}))

// mock.module outlives this file: put the real jobs module back so the stubs above
// never reach a later file in the same bun process (a later spyOn(Queue.prototype)
// would otherwise watch a queue the stub never touches).
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})
const { handleCreateRoutine, handleUpdateRoutine } = await import(
  "~/modules/agent/tools/skills-routines-tools"
)

const ORG = randomUUID()
const OWNER = randomUUID()
const OTHER_THREAD = randomUUID()
const ctx = {
  orgId: ORG,
  userId: OWNER,
  actorType: "user",
  scopes: ["*"],
  approverUserId: OWNER,
} as never

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Own Org', ${`own-${ORG}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${OWNER}, ${ORG}, ${`${OWNER}@own.test`}, 'Owner', 'active', 'hash')`
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${OWNER}, ${ORG}, '*')`
})
afterAll(async () => {
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
})

describe("a routine's own output thread", () => {
  it("stays its destination on an edit that changes something else", async () => {
    const created = (await handleCreateRoutine(
      {
        name: `own-${ORG.slice(0, 6)}`,
        description: "d",
        kind: "recurring" as const,
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: ["kernel:threads:read"],
        runsOn: "node" as const,
      },
      ctx,
    )) as { routine?: { id: string } }
    const id = created.routine!.id
    // The thread the routine worker makes for it: the owner seated, no agent.
    const thread = randomUUID()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
      VALUES (${thread}, ${ORG}, ${`routine-${thread.slice(0, 8)}`}, 'own', 'routine', ${OWNER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${thread}, ${OWNER}, ${ORG}, 'admin')`
    await sql`UPDATE kernel.routines SET output_thread_id = ${thread} WHERE id = ${id}`
    const res = (await handleUpdateRoutine(
      { id, outputThreadId: thread, runsOn: "node_else_cloud" as const } as never,
      ctx,
    )) as { error?: unknown; routine?: { runsOn: string; outputThreadId: string } }
    expect(res.error).toBeUndefined()
    expect(res.routine?.runsOn).toBe("node_else_cloud")
    expect(res.routine?.outputThreadId).toBe(thread)
  })

  // One "where it posts" field (reportThreadId): the run thread is internal,
  // always the routine's own, and an edit naming another one changes nothing.
  it("an edit cannot point the routine's run thread at another thread", async () => {
    const created = (await handleCreateRoutine(
      {
        name: `own2-${ORG.slice(0, 6)}`,
        description: "d",
        kind: "recurring" as const,
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: ["kernel:threads:read"],
      },
      ctx,
    )) as { routine?: { id: string; outputThreadId: string | null } }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
      VALUES (${OTHER_THREAD}, ${ORG}, ${`chan-${OTHER_THREAD.slice(0, 8)}`}, 'chan', 'thread', ${OWNER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${OTHER_THREAD}, ${OWNER}, ${ORG}, 'admin')`
    await handleUpdateRoutine(
      { id: created.routine!.id, outputThreadId: OTHER_THREAD, description: "d2" } as never,
      ctx,
    )
    const [row] =
      await sql`SELECT output_thread_id FROM kernel.routines WHERE id = ${created.routine!.id}`
    expect(row?.output_thread_id ?? null).toBe(created.routine!.outputThreadId ?? null)
  })

  // Walk N12: a routine paused by the system (its owner agent held no scope)
  // stayed paused for ever: toggling it, editing it, nothing set it back to
  // active, and "Run now" kept skipping it.
  it("an edit by its owner gives a system-paused routine another try; a pause the user chose stays", async () => {
    const created = (await handleCreateRoutine(
      {
        name: `paused-${ORG.slice(0, 6)}`,
        description: "d",
        kind: "recurring" as const,
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: ["kernel:threads:read"],
      },
      ctx,
    )) as { routine?: { id: string } }
    const id = created.routine!.id
    await sql`UPDATE kernel.routines SET status = 'paused_scope_mismatch' WHERE id = ${id}`
    const resumed = (await handleUpdateRoutine({ id, enabled: true }, ctx)) as {
      routine?: { status: string }
    }
    expect(resumed.routine?.status).toBe("active")
    await sql`UPDATE kernel.routines SET status = 'paused_user' WHERE id = ${id}`
    const kept = (await handleUpdateRoutine({ id, description: "e" }, ctx)) as {
      routine?: { status: string }
    }
    expect(kept.routine?.status).toBe("paused_user")
  })
})
