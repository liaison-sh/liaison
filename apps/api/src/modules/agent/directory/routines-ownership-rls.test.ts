// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ROUTINES RLS S3 pre-fix failure demonstration (roadmap Phase 1 Validation):
// the first test below ("a second org member with the scope CAN select a
// routine marked visibility=shared") was run by hand against the tree
// BEFORE migration 0048's policy rewrite (owner-only routines_select at
// 0000_initial.sql:2326-2372, zero `visibility` branch) and returned 0 rows
// instead of the expected 1 — confirming the S3 defect was real and that
// this test is falsifiable against the pre-fix policy. Not re-derived on
// every run (mirrors this file's own convention for such demonstrations).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { sql as rawSql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"

const ORG_A = "00000000-0000-0000-0000-e00000000001"
const USER_OWNER = "00000000-0000-0000-0000-e00000000002"
const USER_OTHER = "00000000-0000-0000-0000-e00000000003"

const PERSONAL_AGENT_OWNER = "00000000-0000-0000-0000-e00000000004"
const ROLE_AGENT_NARROW = "00000000-0000-0000-0000-e00000000005"

function rlsCtx(userId: string, scopes: string[] = []): UserContext {
  return { actorType: "user", userId, orgId: ORG_A, scopes, dimensionGrants: {} }
}

beforeAll(async () => {
  await rawSql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_A}, 'Routines Ownership RLS Org', 'routines-ownership-rls-org') ON CONFLICT DO NOTHING`
  await rawSql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_OWNER}, ${ORG_A}, 'routines-rls-owner@test.com', 'Routines RLS Owner', 'active', 1) ON CONFLICT DO NOTHING`
  await rawSql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_OTHER}, ${ORG_A}, 'routines-rls-other@test.com', 'Routines RLS Other', 'active', 1) ON CONFLICT DO NOTHING`

  await withPrivilegedDb(ORG_A, "test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values({
        id: PERSONAL_AGENT_OWNER,
        orgId: ORG_A,
        kind: "personal",
        handle: "owner-agent-routines-rls",
        displayName: "Owner Personal Agent Routines RLS",
        ownerUserId: USER_OWNER,
      })
      .onConflictDoNothing()
    // A role agent whose scopeCeiling requires a scope USER_OTHER never holds,
    // so an insert attempt by USER_OTHER (even holding kernel:agents:admin and
    // kernel:routines:write) must still be refused by the ceiling-superset
    // check, not just the ownership branch.
    await tx
      .insert(agents)
      .values({
        id: ROLE_AGENT_NARROW,
        orgId: ORG_A,
        kind: "role",
        handle: "role-agent-routines-rls-narrow",
        displayName: "Narrow Role Agent Routines RLS",
        scopeCeiling: ["kernel:routines:write", "kernel:scope:caller-does-not-hold"],
      })
      .onConflictDoNothing()
  })
})

afterAll(async () => {
  await rawSql`DELETE FROM kernel.routines WHERE org_id = ${ORG_A}`
  await rawSql`DELETE FROM kernel.agents WHERE org_id = ${ORG_A}`
  await rawSql`DELETE FROM kernel.users WHERE org_id = ${ORG_A}`
  await rawSql`DELETE FROM kernel.organizations WHERE id = ${ORG_A}`
})

describe("ROUTINES RLS S3", () => {
  it("a second org member with the scope CAN select a routine marked visibility=shared", async () => {
    await withPrivilegedDb(ORG_A, "test-seed", async (tx) => {
      await tx
        .insert(routines)
        .values({
          orgId: ORG_A,
          ownerUserId: USER_OWNER,
          ownerAgentId: PERSONAL_AGENT_OWNER,
          name: "shared-routine-s3",
          description: "d",
          kind: "event",
          event: "test.event",
          prompt: "p",
          scopes: [],
          visibility: "shared",
          createdByActorType: "user",
        })
        .onConflictDoNothing()
    })

    const rows = await withRlsContext(rlsCtx(USER_OTHER, ["kernel:routines:read"]), async (tx) => {
      return tx
        .select({ id: routines.id })
        .from(routines)
        .where(sql`${routines.orgId} = ${ORG_A} AND ${routines.name} = 'shared-routine-s3'`)
    })

    expect(rows.length).toBe(1)
  })

  it("a second org member without the scope cannot select a personal (non-shared) routine", async () => {
    await withPrivilegedDb(ORG_A, "test-seed", async (tx) => {
      await tx
        .insert(routines)
        .values({
          orgId: ORG_A,
          ownerUserId: USER_OWNER,
          ownerAgentId: PERSONAL_AGENT_OWNER,
          name: "personal-routine-s3",
          description: "d",
          kind: "event",
          event: "test.event",
          prompt: "p",
          scopes: [],
          visibility: "personal",
          createdByActorType: "user",
        })
        .onConflictDoNothing()
    })

    const rows = await withRlsContext(rlsCtx(USER_OTHER, ["kernel:routines:read"]), async (tx) => {
      return tx
        .select({ id: routines.id })
        .from(routines)
        .where(sql`${routines.orgId} = ${ORG_A} AND ${routines.name} = 'personal-routine-s3'`)
    })

    expect(rows.length).toBe(0)
  })

  it("creating a routine owned by an agent whose ceiling the caller does not fully hold is refused", async () => {
    // Deliberately NOT '*': a wildcard caller scope would also satisfy the
    // ceiling-superset check trivially, which would defeat this test. These
    // two explicit scopes are enough to pass the write-scope check AND the
    // role-agent admin-ownership branch, but not the narrower agent's
    // scopeCeiling (which also requires kernel:scope:caller-does-not-hold).
    await expect(
      withRlsContext(
        rlsCtx(USER_OTHER, ["kernel:routines:write", "kernel:agents:admin"]),
        async (tx) => {
          return tx
            .insert(routines)
            .values({
              orgId: ORG_A,
              ownerUserId: USER_OTHER,
              ownerAgentId: ROLE_AGENT_NARROW,
              name: "ceiling-refused-routine-s3",
              description: "d",
              kind: "event",
              event: "test.event",
              prompt: "p",
              scopes: [],
              visibility: "personal",
              createdByActorType: "user",
            })
            .returning({ id: routines.id })
        },
      ),
    ).rejects.toThrow()
  })
})
