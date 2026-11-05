// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A transfer and its audit row are one fact. The audit row used to be written
// in a SECOND, privileged transaction after the transfer had already committed,
// so a failed audit insert left the asset in its new owner's hands, unrecorded,
// behind a 500 telling the caller the move had not happened.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { reassignAssetOwner } from "~/modules/agent/directory/reassign"

const ORG_ID = crypto.randomUUID()
const USER_ID = crypto.randomUUID()
const AGENT_FROM = crypto.randomUUID()
const AGENT_TO = crypto.randomUUID()
const ROUTINE_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function currentOwner(): Promise<string | null> {
  const [row] = await sql<{ owner_agent_id: string | null }[]>`
    SELECT owner_agent_id FROM kernel.routines WHERE id = ${ROUTINE_ID}`
  return row?.owner_agent_id ?? null
}

async function auditRowCount(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.audit_log
     WHERE org_id = ${ORG_ID} AND action = 'asset_owner_agent_changed'`
  return row?.n ?? -1
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'ReassignAudit', ${`reassign-audit-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${USER_ID}, ${ORG_ID}, ${`reassign-audit-${tag}@test.com`}, 'owner', 'x')`
  for (const [id, handle] of [
    [AGENT_FROM, `@reassign-from-${tag}`],
    [AGENT_TO, `@reassign-to-${tag}`],
  ] as const) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${id}, ${ORG_ID}, 'personal', ${handle}, 'Agent', ${USER_ID}, '[]'::jsonb)`
  }
  await sql`INSERT INTO kernel.routines
      (id, org_id, owner_user_id, name, description, prompt, scopes, created_by_actor_type,
       kind, cron, timezone, owner_agent_id)
    VALUES (${ROUTINE_ID}, ${ORG_ID}, ${USER_ID}, ${`routine-${tag}`}, 'd', 'p', '{}', 'user',
       'recurring', '0 9 * * *', 'UTC', ${AGENT_FROM})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("reassignAssetOwner: the transfer and its audit row commit together", () => {
  it("a failed audit insert leaves the asset with its original owner", async () => {
    await expect(
      reassignAssetOwner(
        actor,
        { asset: "routines", assetId: ROUTINE_ID, ownerAgentId: AGENT_TO },
        {
          writeAudit: async () => {
            throw new Error("audit insert failed")
          },
        },
      ),
    ).rejects.toThrow(/audit insert failed/)

    expect(await currentOwner()).toBe(AGENT_FROM)
    expect(await auditRowCount()).toBe(0)
  })

  it("a successful transfer writes exactly one audit row naming both ends", async () => {
    const result = await reassignAssetOwner(actor, {
      asset: "routines",
      assetId: ROUTINE_ID,
      ownerAgentId: AGENT_TO,
    })
    expect(result).toEqual({ id: ROUTINE_ID, ownerAgentId: AGENT_TO })
    expect(await currentOwner()).toBe(AGENT_TO)
    expect(await auditRowCount()).toBe(1)

    const [row] = await sql<{ entity_id: string; changes: Record<string, unknown> }[]>`
      SELECT entity_id, changes FROM kernel.audit_log
       WHERE org_id = ${ORG_ID} AND action = 'asset_owner_agent_changed'`
    expect(row?.entity_id).toBe(ROUTINE_ID)
    expect(row?.changes).toEqual({ ownerAgentId: { from: AGENT_FROM, to: AGENT_TO } })
  })
})
