// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `resolveActingAgentIdForWrite` runs on the message write path, INSIDE the
// caller's already-open transaction. Its last-resort `@base` bootstrap used to
// open a second, privileged transaction from the SAME pool, so one message write
// held two connections of one pool at once, and under pool pressure the inner
// acquire waited on a pool the outer connection was itself occupying.
//
// Now (privilegedFrom): on a transaction whose login can elevate, the bootstrap
// runs on the caller's own connection; on a request transaction on the request
// login, which cannot elevate, it runs on the PRIVILEGED pool, never the
// caller's own.
//
// The probe is the transaction boundary: a row written on the caller's own
// handle is invisible to every other connection until the caller commits. A row
// visible from a SECOND connection while the caller's transaction is still open
// was written on a SECOND connection.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as sqlRaw } from "drizzle-orm"
import { sql } from "~/db"
import { __privileged_pool_db__ } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import { resolveActingAgentIdForWrite } from "~/modules/threads/message"

/** Request transactions on liaison_request (every namespaced run) or on DATABASE_URL
 *  (the unsplit-logins suite, scripts/test-run.ts). */
const SPLIT = Boolean(env.DATABASE_REQUEST_PASSWORD)
const ORG_ID = crypto.randomUUID()
const USER_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const ctx: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: [],
  dimensionGrants: {},
}

/** Agents of this org as an INDEPENDENT connection sees them. */
async function agentsVisibleElsewhere(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.agents WHERE org_id = ${ORG_ID}`
  return row?.n ?? -1
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'ActingAgentTx', ${`acting-agent-tx-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${USER_ID}, ${ORG_ID}, ${`acting-agent-tx-${tag}@test.com`}, 'writer', 'x')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("resolveActingAgentIdForWrite: no second pool connection", () => {
  it("bootstraps the org base agent on the caller's own transaction when its login can elevate", async () => {
    expect(await agentsVisibleElsewhere()).toBe(0)

    const { agentId, seenMidTransaction } = await withRlsContext(
      ctx,
      async (tx) => {
        const resolved = await resolveActingAgentIdForWrite(tx, {
          orgId: ORG_ID,
          userId: USER_ID,
          authorType: "agent",
        })
        // Still inside the caller's transaction: a second connection must see
        // NOTHING, because the bootstrap ran on this connection.
        return { agentId: resolved, seenMidTransaction: await agentsVisibleElsewhere() }
      },
      // An RLS transaction on the privileged login.
      { db: __privileged_pool_db__ },
    )

    expect(seenMidTransaction).toBe(0)
    expect(await agentsVisibleElsewhere()).toBe(1)

    const [row] = await sql<{ id: string; handle: string; kind: string }[]>`
      SELECT id, handle, kind FROM kernel.agents WHERE org_id = ${ORG_ID}`
    expect(row?.handle).toBe("@base")
    expect(row?.kind).toBe("system")
    expect(agentId).toBe(row?.id ?? "")
  })

  it("from a request transaction, bootstraps on the privileged pool when its login cannot elevate, in place when it can", async () => {
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    const { agentId, seenMidTransaction, login } = await withRlsContext(ctx, async (tx) => {
      const resolved = await resolveActingAgentIdForWrite(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        authorType: "agent",
      })
      const rows = (await tx.execute(
        sqlRaw`SELECT session_user::text AS login`,
      )) as unknown as Array<{ login: string }>
      return {
        agentId: resolved,
        seenMidTransaction: await agentsVisibleElsewhere(),
        login: rows[0]?.login,
      }
    })
    if (SPLIT) {
      // The request login cannot elevate: the agent was written on another
      // connection (the privileged pool) and committed before the caller did.
      expect(login).toBe("liaison_request")
      expect(seenMidTransaction).toBe(1)
    } else {
      // One login for every pool: it elevates on the caller's own connection,
      // so nothing is visible elsewhere until the caller commits.
      expect(login).not.toBe("liaison_request")
      expect(seenMidTransaction).toBe(0)
    }
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.agents WHERE org_id = ${ORG_ID} AND handle = '@base'`
    expect(agentId).toBe(row?.id ?? "")
  })

  it("leaves the caller's transaction on its own role", async () => {
    const role = await withRlsContext(ctx, async (tx) => {
      await resolveActingAgentIdForWrite(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        authorType: "agent",
      })
      const rows = (await tx.execute(
        sqlRaw`SELECT current_user::text AS role`,
      )) as unknown as Array<{ role: string }>
      return rows[0]?.role
    })
    expect(role).toBe("liaison_rls")
  })
})
