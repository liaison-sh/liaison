// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure effective-scope computation: one function per room kind (channel, DM,
// routine tick, delegation) plus the withheld-capability set difference.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { intersectScopes, isScopeSubset } from "~/modules/agent/subruns/spawn-agent"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  computeEffectiveScopeForTurn,
  delegateToAgent,
  effectiveScopeChannel,
  effectiveScopeDelegation,
  effectiveScopeDm,
  effectiveScopeRoutineTick,
  turnToolScopes,
  withheldByRoom,
  withheldCapabilities,
} from "./effective-scope"

const sorted = (xs: string[]): string[] => [...xs].sort()

describe("effectiveScopeChannel", () => {
  test("effectiveScopeChannel intersects ceiling with every members grants, not the union", () => {
    const ceiling = ["a:b:*", "c:d:read"]
    const memberA = ["a:b:*", "x:y:read"]
    const memberB = ["a:b:read"]
    expect(effectiveScopeChannel(ceiling, [memberA, memberB])).toEqual(["a:b:read"])
  })

  test("effectiveScopeChannel with two members holding different scope sets equals the intersection, never the union", () => {
    const ceiling = ["*"]
    const memberA = ["finance:reports:read"]
    const memberB = ["logistics:shipments:write"]
    expect(effectiveScopeChannel(ceiling, [memberA, memberB])).toEqual([])

    // Companion: one shared scope is the entire result, not A union B.
    const sharedA = ["finance:reports:read", "shared:notes:read"]
    const sharedB = ["logistics:shipments:write", "shared:notes:read"]
    const result = effectiveScopeChannel(ceiling, [sharedA, sharedB])
    expect(result).toEqual(["shared:notes:read"])
    expect(result).not.toContain("finance:reports:read")
    expect(result).not.toContain("logistics:shipments:write")
  })

  test("effectiveScopeChannel with no human members fails closed to an empty scope", () => {
    // The routine-tick and delegation cases have their own functions; an empty
    // member list must never fall back to the full ceiling.
    expect(effectiveScopeChannel(["*"], [])).toEqual([])
    expect(effectiveScopeChannel(["a:b:read", "c:d:write"], [])).toEqual([])
  })
})

describe("effectiveScopeDm", () => {
  test("effectiveScopeDm equals ceiling intersected with requester alone", () => {
    const ceiling = ["a:*", "b:*"]
    const requester = ["a:read"]
    const expected = intersectScopes(["a:*", "b:*"], ["a:read"])
    expect(effectiveScopeDm(ceiling, requester)).toEqual(expected)
    expect(effectiveScopeDm(ceiling, requester)).toEqual(["a:read"])
  })
})

describe("effectiveScopeRoutineTick", () => {
  test("effectiveScopeRoutineTick returns the ceiling unchanged", () => {
    const ceiling = ["a:b:read", "c:d:write"]
    expect(sorted(effectiveScopeRoutineTick(ceiling))).toEqual(sorted(["a:b:read", "c:d:write"]))
  })
})

describe("effectiveScopeDelegation", () => {
  test("effectiveScopeDelegation intersects caller effective scope with callee ceiling, not caller ceiling", () => {
    const narrowCaller = ["a:b:read"]
    const calleeCeiling = ["a:b:read", "a:b:write"]
    expect(effectiveScopeDelegation(narrowCaller, calleeCeiling)).toEqual(["a:b:read"])

    // Confused deputy: a caller wider than the callee's ceiling is still
    // bounded by that ceiling.
    const wideCaller = ["a:b:*", "c:d:read", "*"]
    const narrowCallee = ["a:b:read"]
    const bounded = effectiveScopeDelegation(wideCaller, narrowCallee)
    expect(bounded).toEqual(["a:b:read"])
    expect(isScopeSubset(bounded, narrowCallee)).toBe(true)
    expect(bounded).not.toContain("c:d:read")
    expect(bounded).not.toContain("*")
  })
})

describe("delegateToAgent", () => {
  const ORG = "00000000-0000-0000-0000-e5c0de000001"
  const OTHER_ORG = "00000000-0000-0000-0000-e5c0de000002"
  const USER = "00000000-0000-0000-0000-e5c0de000003"
  const NARROW_CALLEE = "00000000-0000-0000-0000-e5c0de000004"
  const WIDE_CALLEE = "00000000-0000-0000-0000-e5c0de000005"
  const ARCHIVED_CALLEE = "00000000-0000-0000-0000-e5c0de000006"
  const FOREIGN_CALLEE = "00000000-0000-0000-0000-e5c0de000007"
  const WIDE = ["a:b:read", "a:b:write", "c:d:admin"]

  const ctx: UserContext = {
    actorType: "user",
    userId: USER,
    orgId: ORG,
    scopes: [],
    dimensionGrants: {},
  }

  beforeAll(async () => {
    for (const [id, slug] of [
      [ORG, "effective-scope-delegation-org"],
      [OTHER_ORG, "effective-scope-delegation-other"],
    ]) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, ${slug}, ${slug}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER}, ${ORG}, 'effective-scope-delegation@test.com', 'Delegation User', 'active', 1) ON CONFLICT DO NOTHING`
    await withPrivilegedDb(ORG, "test-seed", async (tx) => {
      await tx
        .insert(agents)
        .values([
          {
            id: NARROW_CALLEE,
            orgId: ORG,
            kind: "role",
            handle: "delegation-narrow",
            displayName: "Narrow Callee",
            scopeCeiling: ["a:b:read"],
          },
          {
            id: WIDE_CALLEE,
            orgId: ORG,
            kind: "role",
            handle: "delegation-wide",
            displayName: "Wide Callee",
            scopeCeiling: WIDE,
          },
          {
            id: ARCHIVED_CALLEE,
            orgId: ORG,
            kind: "role",
            handle: "delegation-archived",
            displayName: "Archived Callee",
            scopeCeiling: WIDE,
            archivedAt: new Date(),
          },
        ])
        .onConflictDoNothing()
    })
    await withPrivilegedDb(OTHER_ORG, "test-seed", async (tx) => {
      await tx
        .insert(agents)
        .values({
          id: FOREIGN_CALLEE,
          orgId: OTHER_ORG,
          kind: "role",
          handle: "delegation-foreign",
          displayName: "Foreign Callee",
          scopeCeiling: WIDE,
        })
        .onConflictDoNothing()
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agents WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
  })

  test("delegateToAgent bounds the result by the callees ceiling even when the caller effective scope is wider", async () => {
    const result = await withRlsContext(ctx, (tx) =>
      delegateToAgent(tx, ORG, ["a:b:read", "a:b:write", "c:d:admin"], NARROW_CALLEE),
    )
    expect(result.effectiveScope).toEqual(["a:b:read"])
    // Withheld is relative to the callee's ceiling, all of which survived.
    expect(result.withheld).toEqual([])
  })

  test("delegateToAgent never widens past the callers own effective scope even when the callee ceiling is wider", async () => {
    const result = await withRlsContext(ctx, (tx) =>
      delegateToAgent(tx, ORG, ["a:b:read"], WIDE_CALLEE),
    )
    expect(result.effectiveScope).toEqual(["a:b:read"])
    expect(sorted(result.withheld)).toEqual(sorted(["a:b:write", "c:d:admin"]))
  })

  test("delegateToAgent refuses an archived, foreign-org or unknown callee instead of returning a scope", async () => {
    const unknown = "00000000-0000-0000-0000-e5c0de0000ff"
    for (const callee of [ARCHIVED_CALLEE, FOREIGN_CALLEE, unknown]) {
      await expect(
        withRlsContext(ctx, (tx) => delegateToAgent(tx, ORG, WIDE, callee)),
      ).rejects.toThrow("delegation target")
    }
  })

  test("delegateToAgent rejects a foreign-org callee by its own explicit org filter, not just RLS", async () => {
    // withRlsContext scopes the connection to ORG, so RLS alone already
    // hides FOREIGN_CALLEE's row (it lives in OTHER_ORG) and the test above
    // cannot tell whether delegateToAgent's explicit eq(agents.orgId, orgId)
    // filter did anything. withPrivilegedDb switches to the BYPASSRLS role,
    // so FOREIGN_CALLEE's row IS visible here regardless of RLS; only the
    // explicit filter can still reject it. If that filter were ever removed,
    // this call would find the row and resolve instead of throwing.
    await expect(
      withPrivilegedDb(ORG, "test-foreign-org-explicit-filter", (tx) =>
        delegateToAgent(tx as unknown as RlsClient, ORG, WIDE, FOREIGN_CALLEE),
      ),
    ).rejects.toThrow("delegation target")
  })
})

describe("withheldByRoom", () => {
  test("withheldByRoom is empty when the room keeps everything the requester could use", () => {
    expect(
      withheldByRoom(["ads:*", "x:y:read"], ["ads:campaigns:read"], ["ads:campaigns:read"]),
    ).toEqual([])
  })

  test("withheldByRoom names only what the requester holds and the room removed", () => {
    const ceiling = ["ads:*", "x:y:read"]
    const requester = ["ads:campaigns:read", "ads:insights:read"]
    expect(withheldByRoom(ceiling, requester, ["ads:insights:read"])).toEqual([
      "ads:campaigns:read",
    ])
  })

  test("withheldByRoom treats an effective glob as covering its concrete scopes", () => {
    expect(withheldByRoom(["ads:campaigns:read"], ["ads:*"], ["ads:*"])).toEqual([])
  })
})

describe("withheldCapabilities", () => {
  test("withheldCapabilities returns ceiling minus effective scope", () => {
    const ceiling = ["a:b:read", "c:d:write", "e:f:read"]
    const effective = ["a:b:read"]
    expect(sorted(withheldCapabilities(ceiling, effective))).toEqual(
      sorted(["c:d:write", "e:f:read"]),
    )
  })
})

describe("computeEffectiveScopeForTurn", () => {
  const CEILING = ["a:b:read", "c:d:write"]
  let orgId: string

  async function seedThread(
    type: string,
    createdBy: string,
    participantIds: string[],
  ): Promise<string> {
    return withPrivilegedDb(orgId, "test-effective-scope-seed-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({ orgId, handle: `es-${crypto.randomUUID().slice(0, 8)}`, type, createdBy })
        .returning({ id: threads.id })
      for (const userId of participantIds) {
        await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      }
      return t.id
    })
  }

  function computeFor(threadId: string, requesterUserId: string) {
    return withPrivilegedDb(orgId, "test-effective-scope-for-turn", (tx) =>
      computeEffectiveScopeForTurn(tx, orgId, threadId, requesterUserId, CEILING),
    )
  }

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
  })
  afterAll(releaseTestLock)

  test("computeEffectiveScopeForTurn routes a routine thread to the unfloored ceiling", async () => {
    const user = await minimal.person(orgId)
    await minimal.revokeRole(user.id, "member")
    const threadId = await seedThread("routine", user.id, [user.id])

    const result = await computeFor(threadId, user.id)

    expect(result.effectiveScope).toEqual(CEILING)
    expect(result.withheld).toEqual([])
  })

  test("computeEffectiveScopeForTurn routes a DM thread to ceiling intersected with the requester", async () => {
    const requester = await minimal.person(orgId)
    await minimal.revokeRole(requester.id, "member")
    await minimal.grantScope(requester.id, "a:b:read")
    const threadId = await seedThread("agent_chat", requester.id, [requester.id])

    const result = await computeFor(threadId, requester.id)

    expect(result.effectiveScope).toEqual(["a:b:read"])
    // The requester's own missing grant is not withheld by the room: there is
    // nobody else in a DM, so a card would offer a DM the person is already in.
    expect(result.withheld).toEqual([])
  })

  test("computeEffectiveScopeForTurn reports nothing withheld when a glob ceiling meets concrete grants", async () => {
    const requester = await minimal.person(orgId)
    await minimal.revokeRole(requester.id, "member")
    await minimal.grantScope(requester.id, "g:campaigns:read")
    await minimal.grantScope(requester.id, "g:insights:read")
    const ceiling = ["g:*", "h:*"]
    // A 1:1 agent DM held as a thread with the requester as the only human.
    const room = await seedThread("thread", requester.id, [requester.id])
    const dm = await seedThread("agent_chat", requester.id, [requester.id])

    for (const threadId of [room, dm]) {
      const result = await withPrivilegedDb(orgId, "test-effective-scope-glob", (tx) =>
        computeEffectiveScopeForTurn(tx, orgId, threadId, requester.id, ceiling),
      )
      expect(sorted(result.effectiveScope)).toEqual(sorted(["g:campaigns:read", "g:insights:read"]))
      expect(result.withheld).toEqual([])
    }
  })

  test("computeEffectiveScopeForTurn withholds the concrete scopes another member lacks under a glob ceiling", async () => {
    const alice = await minimal.person(orgId)
    const bob = await minimal.person(orgId)
    await minimal.revokeRole(alice.id, "member")
    await minimal.revokeRole(bob.id, "member")
    await minimal.grantScope(alice.id, "g:campaigns:read")
    await minimal.grantScope(alice.id, "g:insights:read")
    await minimal.grantScope(bob.id, "g:insights:read")
    const threadId = await seedThread("thread", alice.id, [alice.id, bob.id])

    const result = await withPrivilegedDb(orgId, "test-effective-scope-glob-room", (tx) =>
      computeEffectiveScopeForTurn(tx, orgId, threadId, alice.id, ["g:*"]),
    )

    expect(result.effectiveScope).toEqual(["g:insights:read"])
    expect(result.withheld).toEqual(["g:campaigns:read"])
  })

  test("computeEffectiveScopeForTurn routes a channel thread to the full member intersection", async () => {
    const alice = await minimal.person(orgId)
    const bob = await minimal.person(orgId)
    await minimal.revokeRole(alice.id, "member")
    await minimal.revokeRole(bob.id, "member")
    await minimal.grantScope(alice.id, "a:b:read")
    await minimal.grantScope(bob.id, "c:d:write")
    const threadId = await seedThread("thread", alice.id, [alice.id, bob.id])

    const result = await computeFor(threadId, alice.id)

    // Each member alone would keep half the ceiling; together nothing overlaps.
    // Withheld is what alice would have had in a DM and the room took away.
    expect(result.effectiveScope).toEqual([])
    expect(result.withheld).toEqual(["a:b:read"])
  })
})

describe("turnToolScopes", () => {
  const actor = [
    "kernel:bug_reports:file",
    "tickets:tickets:read",
    "tickets:tickets:write",
    "kernel:org:admin",
  ]

  test("keeps the every-member bug scope under a ceiling that leaves it out, and unlocks no other scope", () => {
    const scopes = turnToolScopes(actor, { effectiveScope: ["tickets:tickets:read"] })
    expect(sorted(scopes)).toEqual(["kernel:bug_reports:file", "tickets:tickets:read"])
    expect(scopes).not.toContain("tickets:tickets:write")
    expect(scopes).not.toContain("kernel:org:admin")
  })

  test("an empty ceiling admits the bug scope and nothing else", () => {
    expect(turnToolScopes(actor, { effectiveScope: [] })).toEqual(["kernel:bug_reports:file"])
  })

  test("never widens past the actor: a person without the scope gets none from the exemption", () => {
    const scopes = turnToolScopes(["tickets:tickets:read"], {
      effectiveScope: ["kernel:bug_reports:file", "tickets:tickets:read"],
    })
    expect(scopes).toEqual(["tickets:tickets:read"])
  })

  test("outside a turn the actor's own scopes stand", () => {
    expect(turnToolScopes(actor, undefined)).toEqual(actor)
  })
})
