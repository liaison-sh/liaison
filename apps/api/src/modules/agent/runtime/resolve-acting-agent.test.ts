// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `actingAgentId` branch of resolveActingAgent: the agent an @mention
// addressed. It resolves a LIVE agent of THIS org and nothing else, and an id
// it cannot resolve addresses NOBODY — it must never quietly become the
// requester's own personal agent, which would put a turn in a room the named
// agent never joined (S12, same rule the send route enforces before dispatch).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents, organizations } from "~/db/schema/kernel"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { resolveActingAgent } from "./agent-service"

let orgId: string
let userId: string
let foreignOrgId: string
let personalAgentId: string
let roleAgentId: string
let archivedAgentId: string
let foreignAgentId: string

async function seedAgent(
  inOrg: string,
  kind: "personal" | "role",
  ownerUserId: string | null,
  archived: boolean,
): Promise<string> {
  return withPrivilegedDb(inOrg, "test-resolve-acting-agent-seed", async (tx) => {
    const [a] = await tx
      .insert(agents)
      .values({
        orgId: inOrg,
        kind,
        handle: `@raa-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "RAA",
        ownerUserId,
        archivedAt: archived ? new Date() : null,
      })
      .returning({ id: agents.id })
    return a!.id
  })
}

function resolve(actingAgentId?: string) {
  return withPrivilegedDb(orgId, "test-resolve-acting-agent", (tx) =>
    resolveActingAgent(tx, orgId, userId, undefined, actingAgentId),
  )
}

describe("resolveActingAgent, the mentioned-agent branch", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const user = await minimal.person((await createTestOrg()).id)
    orgId = user.orgId
    userId = user.id
    // A SECOND org, inserted directly: createTestOrg truncates every org-scoped
    // table, so it cannot be used to stand one up beside another.
    foreignOrgId = await withSystemDb("test-resolve-acting-agent-other-org", async (db) => {
      const slug = `raa-other-${crypto.randomUUID().slice(0, 8)}`
      const [o] = await db
        .insert(organizations)
        .values({ name: "RAA Other", slug })
        .returning({ id: organizations.id })
      return o!.id
    })
    // The member's registration gave them their one personal agent: the
    // fallback this branch must NOT reach when an agent is named.
    const [personal] = await withPrivilegedDb(orgId, "test-resolve-acting-agent-personal", (tx) =>
      tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.orgId, orgId), eq(agents.kind, "personal"), eq(agents.ownerUserId, userId)),
        ),
    )
    if (!personal) throw new Error("registration created no personal agent")
    personalAgentId = personal.id
    roleAgentId = await seedAgent(orgId, "role", null, false)
    archivedAgentId = await seedAgent(orgId, "role", null, true)
    foreignAgentId = await seedAgent(foreignOrgId, "role", null, false)
  })
  afterAll(releaseTestLock)

  it("resolves the named live agent of this org", async () => {
    expect((await resolve(roleAgentId))?.id).toBe(roleAgentId)
  })

  it("resolves the requester's personal agent when no agent is named", async () => {
    expect((await resolve())?.id).toBe(personalAgentId)
  })

  it("resolves nobody when the named agent belongs to another org", async () => {
    expect(await resolve(foreignAgentId)).toBeNull()
  })

  it("resolves nobody when the named agent is archived", async () => {
    expect(await resolve(archivedAgentId)).toBeNull()
  })

  it("resolves nobody when the named agent does not exist", async () => {
    expect(await resolve(crypto.randomUUID())).toBeNull()
  })
})
