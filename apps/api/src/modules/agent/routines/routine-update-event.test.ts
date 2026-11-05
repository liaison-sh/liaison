// SPDX-License-Identifier: FSL-1.1-ALv2
// Switching a routine on or off through PUT /api/agent/routines/:id queues the
// durable `kernel/routine:update {routineId, enabled}` (ids and the flag only),
// once per change: a guided tour's "switch it on" beat completes on it. An
// update that leaves the flag as it was queues nothing.
import { beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { users } from "~/db/schema/kernel"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { handleCreateRoutine } from "~/modules/agent/tools/skills-routines-tools"
import { createAppContext } from "~/modules/apps/context"
import { signAccessToken } from "~/modules/auth/jwt"
import { createTestOrg } from "~/tests/helpers/org"

let orgId: string
let userId: string
let token: string

async function updateEvents(routineId: string) {
  return extractRows<{ payload: { actorId: string; actorType: string; data: unknown } }>(
    await db.execute(drizzleSql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'app' = 'kernel'
        AND payload->>'entity' = 'routine' AND payload->>'action' = 'update'
        AND payload->>'entityId' = ${routineId}
      ORDER BY payload->>'timestamp'`),
  ).map((r) => r.payload)
}

function put(id: string, body: unknown) {
  return app.request(`/api/agent/routines/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  orgId = (await createTestOrg()).id
  userId = await withSystemDb("rue-user", async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        orgId,
        email: `rue-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Routine Switcher",
        status: "active",
      })
      .returning({ id: users.id })
    return u!.id
  })
  token = await signAccessToken(
    { userId, orgId, name: "T", authVersion: 1, permissionVersion: 1, scopes: ["*"] },
    env.JWT_SECRET,
  )
})

describe("kernel/routine:update", () => {
  it("is a declared kernel emit", () => {
    expect(KERNEL_DECLARED_EMITS.has("routine:update")).toBe(true)
  })

  it("queues exactly one event per change of the enabled flag, none for other edits", async () => {
    const created = (await withRlsContext(
      { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
      (tx) =>
        handleCreateRoutine(
          {
            name: "Research interested prospects",
            description: "prospects",
            kind: "recurring",
            cron: "0 9 * * 1",
            timezone: "Europe/Paris",
            prompt: "Research the sender.",
            scopes: [],
            enabled: false,
          },
          { ...createAppContext("kernel", userId, orgId, tx, "user", userId), scopes: ["*"] },
        ),
    )) as { routine?: { id: string } }
    const id = created.routine!.id

    expect((await put(id, { enabled: true })).status).toBe(200)
    let events = await updateEvents(id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorId: userId,
      actorType: "user",
      data: { routineId: id, enabled: true },
    })
    expect(JSON.stringify(events[0]?.data)).not.toContain("Research the sender")

    // The same flag again, or another field: nothing more.
    expect((await put(id, { enabled: true })).status).toBe(200)
    expect((await put(id, { description: "still prospects" })).status).toBe(200)
    expect(await updateEvents(id)).toHaveLength(1)

    expect((await put(id, { enabled: false })).status).toBe(200)
    events = await updateEvents(id)
    expect(events.map((e) => (e.data as { enabled: boolean }).enabled)).toEqual([true, false])
    // A personal routine's frame carries no name: its name stays its owner's.
    expect(events.map((e) => (e.data as { name: unknown }).name)).toEqual([null, null])
  })

  it("a shared routine's frame names it, so a tour beat switches on that routine only", async () => {
    const created = (await withRlsContext(
      { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
      (tx) =>
        handleCreateRoutine(
          {
            name: "Shared prospects",
            description: "prospects",
            kind: "recurring",
            cron: "0 9 * * 1",
            timezone: "Europe/Paris",
            prompt: "Research the sender.",
            scopes: [],
            enabled: false,
            visibility: "shared",
          },
          { ...createAppContext("kernel", userId, orgId, tx, "user", userId), scopes: ["*"] },
        ),
    )) as { routine?: { id: string } }
    const id = created.routine!.id
    expect((await put(id, { enabled: true })).status).toBe(200)
    const events = await updateEvents(id)
    expect(events[0]?.data).toMatchObject({ enabled: true, name: "Shared prospects" })
  })
})
