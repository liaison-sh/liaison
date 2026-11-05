// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Both dedupe paths in thread.ts serialize on a transaction-scoped advisory
// lock, and they used to compute their keys two different ways: the plain-DM
// path with the 63-bit rolling hash, the agent-DM path with Postgres's own
// `hashtext`. Two hash functions over one lock space is two namespaces that
// cannot be reasoned about together, so both now go through one helper.
//
// And `pg_advisory_xact_lock` OUTSIDE a transaction block takes the lock and
// releases it on the same statement: the dedupe would read as serialized and
// be nothing of the kind. The handle is asserted rather than assumed.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows, sql } from "~/db"
import { advisoryLockKey } from "~/db/advisory-lock"
import { type UserContext, withRlsContext } from "~/db/rls"
import { createOrGetAgentDm } from "~/modules/threads/thread"

const ORG_ID = crypto.randomUUID()
const USER_ID = crypto.randomUUID()
const AGENT_ID = crypto.randomUUID()
const OTHER_AGENT_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const ctx: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

/** Every advisory lock this connection holds, as one 64-bit key. */
async function advisoryLocksHeld(tx: RlsClient): Promise<string[]> {
  const rows = extractRows<{ key: string }>(
    await tx.execute(drizzleSql`
      SELECT ((classid::bigint << 32) | objid::bigint)::text AS key
        FROM pg_locks
       WHERE locktype = 'advisory' AND pid = pg_backend_pid()`),
  )
  return rows.map((r) => r.key)
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'AgentDmLock', ${`agent-dm-lock-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${USER_ID}, ${ORG_ID}, ${`agent-dm-lock-${tag}@test.com`}, 'member', 'x')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
    VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', ${`@agent-dm-${tag}`}, 'Agent', ${USER_ID}, '[]'::jsonb)`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
    VALUES (${OTHER_AGENT_ID}, ${ORG_ID}, 'role', ${`@agent-dm-other-${tag}`}, 'Support', NULL, '[]'::jsonb)`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`.catch(() => {})
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("advisoryLockKey", () => {
  it("is deterministic and stays inside the signed 64-bit range", () => {
    expect(advisoryLockKey("a")).toBe(advisoryLockKey("a"))
    expect(advisoryLockKey("a")).not.toBe(advisoryLockKey("b"))
    for (const input of ["", "a", "agent-dm:x:y:z", "x".repeat(400)]) {
      expect(advisoryLockKey(input) >= 0n).toBe(true)
      expect(advisoryLockKey(input) <= 0x7fffffffffffffffn).toBe(true)
    }
  })
})

describe("createOrGetAgentDm: one lock namespace, one helper", () => {
  it("takes its lock on the shared helper's key", async () => {
    const held = await withRlsContext(ctx, async (tx) => {
      await createOrGetAgentDm(tx, { orgId: ORG_ID, userId: USER_ID, agentId: AGENT_ID })
      return advisoryLocksHeld(tx)
    })
    expect(held).toContain(advisoryLockKey(`agent-dm:${ORG_ID}:${USER_ID}:${AGENT_ID}`).toString())
  })

  it("refuses a handle that is not an open transaction", async () => {
    const notATransaction = {
      select: () => {
        throw new Error("should never be reached")
      },
      execute: () => {
        throw new Error("should never be reached")
      },
    } as unknown as RlsClient
    await expect(
      createOrGetAgentDm(notATransaction, {
        orgId: ORG_ID,
        userId: USER_ID,
        agentId: AGENT_ID,
      }),
    ).rejects.toThrow(/transaction/i)
  })
})

// F6. "Discuss this" from Mail landed in the "Liaison, Support" room: the
// find-or-get asked only for a room with ONE human that this agent sits in, so
// a room the user had also seated a second agent in answered as their 1:1 DM.
describe("createOrGetAgentDm: a DM is 1:1 in both directions", () => {
  it("ignores a one-human room that seats a second agent, and makes the real DM", async () => {
    const group = await withRlsContext(ctx, async (tx) => {
      const dm = await createOrGetAgentDm(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        agentId: AGENT_ID,
      })
      // Seat a second agent in the room the user just got: it is now a group.
      await tx.execute(drizzleSql`
        INSERT INTO kernel.thread_participants (thread_id, org_id, agent_id, participant_type)
        VALUES (${dm?.id}, ${ORG_ID}, ${OTHER_AGENT_ID}, 'agent')`)
      return dm
    })
    expect(group?.id).toBeTruthy()

    const resolved = await withRlsContext(ctx, (tx) =>
      createOrGetAgentDm(tx, { orgId: ORG_ID, userId: USER_ID, agentId: AGENT_ID }),
    )

    expect(resolved?.id).not.toBe(group?.id)
    expect(resolved?.created).toBe(true)

    // And it is stable from then on: the fresh 1:1 answers every later call.
    const again = await withRlsContext(ctx, (tx) =>
      createOrGetAgentDm(tx, { orgId: ORG_ID, userId: USER_ID, agentId: AGENT_ID }),
    )
    expect(again?.id).toBe(resolved?.id)
    expect(again?.created).toBe(false)
  })
})
