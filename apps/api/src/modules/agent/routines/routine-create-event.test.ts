// SPDX-License-Identifier: FSL-1.1-ALv2
// Creating a routine (by hand or from a template) queues `kernel/routine:create`
// in the insert's transaction. Before this only status changes and finished runs
// were announced, so nothing (a guided tour beat included) could tell a routine
// had just been made. The frame carries ids and the routine's shape only, never
// its name or prompt: a personal routine is its owner's business.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { routines, users } from "~/db/schema/kernel"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import {
  handleCreateRoutine,
  handleEnableRoutineTemplate,
} from "~/modules/agent/tools/skills-routines-tools"
import { type AppContext, createAppContext } from "~/modules/apps/context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createTestOrg } from "~/tests/helpers/org"

let orgId: string
let userId: string

async function routineCtx(scopes: string[]): Promise<AppContext & { scopes: string[] }> {
  return withRlsContext(
    { actorType: "user", userId, orgId, scopes, dimensionGrants: {} },
    async (tx) => ({ ...createAppContext("kernel", userId, orgId, tx, "user", userId), scopes }),
  )
}

async function createEvents(routineId: string): Promise<
  Array<{
    actorId: string
    actorType: string
    entityId: string
    data: Record<string, unknown>
  }>
> {
  return extractRows<{ payload: never }>(
    await db.execute(drizzleSql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'app' = 'kernel'
        AND payload->>'entity' = 'routine' AND payload->>'action' = 'create'
        AND payload->>'entityId' = ${routineId}
    `),
  ).map((r) => r.payload)
}

beforeEach(async () => {
  const org = await createTestOrg()
  orgId = org.id
  userId = await withSystemDb("rce-user", async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        orgId,
        email: `rce-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Routine Maker",
        status: "active",
      })
      .returning({ id: users.id })
    return u!.id
  })
})

afterEach(async () => {
  await withSystemDb("rce-clean", (tx) => tx.delete(routines).where(eq(routines.orgId, orgId)))
})

describe("kernel/routine:create", () => {
  it("is a declared kernel emit", () => {
    expect(KERNEL_DECLARED_EMITS.has("routine:create")).toBe(true)
  })

  it("handleCreateRoutine queues it with the creator as actor and no name or prompt", async () => {
    const res = (await handleCreateRoutine(
      {
        name: "Weekly digest",
        description: "digest",
        kind: "recurring",
        cron: "0 9 * * 1",
        timezone: "Europe/Paris",
        prompt: "Summarize the week.",
        scopes: [],
        enabled: false,
      },
      await routineCtx(["*"]),
    )) as { routine?: { id: string }; error?: unknown }
    expect(res.error).toBeUndefined()
    const id = res.routine!.id
    const events = await createEvents(id)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.actorId).toBe(userId)
    expect(e.actorType).toBe("user")
    expect(e.data).toMatchObject({
      id,
      routineId: id,
      kind: "recurring",
      ownerUserId: userId,
      createdByUserId: userId,
      visibility: "personal",
    })
    expect(JSON.stringify(e.data)).not.toContain("Summarize the week")
    expect(JSON.stringify(e.data)).not.toContain("Weekly digest")
  })

  it("enabling a routine template queues it too", async () => {
    await ensureAppsForOrg(orgId, {})
    const res = (await handleEnableRoutineTemplate(
      { appName: "kernel", templateKey: "morning-brief", time: "07:30" },
      await routineCtx(["*"]),
    )) as { routine?: { id: string }; error?: unknown }
    expect(res.error).toBeUndefined()
    const [e] = await createEvents(res.routine!.id)
    expect(e?.data).toMatchObject({ templateKey: "morning-brief", ownerUserId: userId })
  })
})
