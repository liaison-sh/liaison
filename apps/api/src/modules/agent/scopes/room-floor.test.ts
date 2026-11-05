// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agents, threadParticipants, threads } from "~/db/schema/kernel"
import { everyMemberScopeGrants, loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { resolveRoomFloor } from "./room-floor"

let orgId: string

async function seedThread(
  type: string,
  createdBy: string,
  participantIds: string[],
): Promise<string> {
  return withPrivilegedDb(orgId, "test-room-floor-seed-thread", async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({
        orgId,
        handle: `rf-${crypto.randomUUID().slice(0, 8)}`,
        type,
        createdBy,
      })
      .returning({ id: threads.id })
    for (const userId of participantIds) {
      await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
    }
    return t.id
  })
}

function resolve(threadId: string, requesterUserId: string) {
  return withPrivilegedDb(orgId, "test-room-floor-resolve", (tx) =>
    resolveRoomFloor(tx, orgId, threadId, requesterUserId),
  )
}

function scopesOf(userId: string): Promise<string[]> {
  return withPrivilegedDb(
    orgId,
    "test-room-floor-perms",
    async (tx) => (await loadEffectivePermissions(tx, userId, orgId)).scopes,
  )
}

/**
 * A member's grants as the floor sees them: their own scopes plus the scopes the
 * org's apps give every active member (manifest `everyMemberScopes`), which
 * every member of a room holds, so the intersection keeps them.
 */
async function grantsOf(userId: string, ...own: string[]): Promise<string[]> {
  const every = await withPrivilegedDb(orgId, "test-room-floor-every-member", (tx) =>
    everyMemberScopeGrants(tx, userId, orgId),
  )
  return [...new Set([...every.map((g) => g.scope), ...own])].sort()
}

const sorted = (grants: string[][]) =>
  grants.map((g) => [...g].sort()).sort((a, b) => a.join(",").localeCompare(b.join(",")))

describe("resolveRoomFloor", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
  })
  afterAll(releaseTestLock)

  it("resolveRoomFloor returns routine_tick for a routine-type thread with no member grants", async () => {
    const user = await minimal.person(orgId)
    const threadId = await seedThread("routine", user.id, [user.id])

    const result = await resolve(threadId, user.id)

    expect(result.kind).toBe("routine_tick")
    expect("memberGrants" in result).toBe(false)
  })

  it("resolveRoomFloor returns dm with only the requesters own grants for an agent_chat thread", async () => {
    const requester = await minimal.person(orgId)
    await minimal.revokeRole(requester.id, "member")
    await minimal.grantScope(requester.id, "a:b:read")
    const threadId = await seedThread("agent_chat", requester.id, [requester.id])

    const result = await resolve(threadId, requester.id)

    expect(result.kind).toBe("dm")
    if (result.kind === "routine_tick") throw new Error("unreachable")
    expect(sorted(result.memberGrants)).toEqual([await grantsOf(requester.id, "a:b:read")])
  })

  it("resolveRoomFloor returns channel with every human members grants for a thread-type room", async () => {
    const alice = await minimal.person(orgId)
    const bob = await minimal.person(orgId)
    await minimal.revokeRole(bob.id, "member")
    await minimal.grantScope(alice.id, "room:alice:read")
    await minimal.grantScope(bob.id, "room:bob:write")
    const threadId = await seedThread("thread", alice.id, [alice.id, bob.id])

    const aliceScopes = await scopesOf(alice.id)
    const bobScopes = await scopesOf(bob.id)
    expect(aliceScopes).toContain("room:alice:read")
    expect([...bobScopes].sort()).toEqual(await grantsOf(bob.id, "room:bob:write"))

    const result = await resolve(threadId, alice.id)

    expect(result.kind).toBe("channel")
    if (result.kind === "routine_tick") throw new Error("unreachable")
    expect(result.memberGrants).toHaveLength(2)
    expect(sorted(result.memberGrants)).toEqual(sorted([aliceScopes, bobScopes]))
  })

  it("resolveRoomFloor returns channel with every human members grants for an approval discussion thread", async () => {
    const requester = await minimal.person(orgId)
    const approver = await minimal.person(orgId)
    await minimal.revokeRole(requester.id, "member")
    await minimal.revokeRole(approver.id, "member")
    await minimal.grantScope(requester.id, "room:requester:read")
    await minimal.grantScope(approver.id, "room:approver:write")
    const threadId = await seedThread("approval", requester.id, [requester.id, approver.id])

    const result = await resolve(threadId, requester.id)

    expect(result.kind).toBe("channel")
    if (result.kind === "routine_tick") throw new Error("unreachable")
    expect(sorted(result.memberGrants)).toEqual(
      sorted([
        await grantsOf(requester.id, "room:requester:read"),
        await grantsOf(approver.id, "room:approver:write"),
      ]),
    )
  })

  it("resolveRoomFloor ignores an agent participant row when flooring an approval thread", async () => {
    // Since 0075 a participant row can be an AGENT (user_id NULL). An agent
    // holds no user grants, so counting it as a member would add an EMPTY grant
    // list to the floor, which reads as "a member who may see nothing" and
    // floors the whole room to nothing.
    const requester = await minimal.person(orgId)
    await minimal.revokeRole(requester.id, "member")
    await minimal.grantScope(requester.id, "room:agentfloor:read")
    const threadId = await seedThread("approval", requester.id, [requester.id])
    const agentId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "test-room-floor-seed-agent", async (tx) => {
      await tx.insert(agents).values({
        id: agentId,
        orgId,
        kind: "role",
        handle: `rf-agent-${agentId.slice(0, 8)}`,
        displayName: "Room floor agent",
      })
      await tx
        .insert(threadParticipants)
        .values({ threadId, agentId, orgId, participantType: "agent" })
    })

    const result = await resolve(threadId, requester.id)

    expect(result.kind).toBe("channel")
    if (result.kind === "routine_tick") throw new Error("unreachable")
    expect(sorted(result.memberGrants)).toEqual([
      await grantsOf(requester.id, "room:agentfloor:read"),
    ])
  })

  it("resolveRoomFloor folds a non-participant requester into an approval thread channel floor", async () => {
    const owner = await minimal.person(orgId)
    const outsider = await minimal.person(orgId)
    await minimal.revokeRole(outsider.id, "member")
    await minimal.grantScope(outsider.id, "room:outsider:read")
    const threadId = await seedThread("approval", owner.id, [owner.id])

    const result = await resolve(threadId, outsider.id)

    expect(result.kind).toBe("channel")
    if (result.kind === "routine_tick") throw new Error("unreachable")
    expect(result.memberGrants).toHaveLength(2)
    expect(sorted(result.memberGrants)).toContainEqual(
      await grantsOf(outsider.id, "room:outsider:read"),
    )
  })

  it("resolveRoomFloor throws E_ROOM_FLOOR_UNSUPPORTED_THREAD_TYPE for a subrun thread", async () => {
    const user = await minimal.person(orgId)
    const threadId = await seedThread("subrun", user.id, [user.id])

    await expect(resolve(threadId, user.id)).rejects.toMatchObject({
      code: "E_ROOM_FLOOR_UNSUPPORTED_THREAD_TYPE",
    })
  })

  it("resolveRoomFloor throws E_ROOM_FLOOR_UNSUPPORTED_THREAD_TYPE for a thread type it does not know", async () => {
    // The schema CHECK forbids inserting an unknown type, so a stub db hands
    // one back to prove the default branch still fails closed.
    const stubDb = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ type: "not_a_real_type" }] }) }),
      }),
    } as unknown as PrivilegedDb
    const user = await minimal.person(orgId)

    await expect(
      resolveRoomFloor(stubDb, orgId, crypto.randomUUID(), user.id),
    ).rejects.toMatchObject({ code: "E_ROOM_FLOOR_UNSUPPORTED_THREAD_TYPE" })
  })

  it("resolveRoomFloor throws E_ROOM_FLOOR_THREAD_NOT_FOUND for an unknown thread, never routine_tick", async () => {
    const user = await minimal.person(orgId)

    await expect(resolve(crypto.randomUUID(), user.id)).rejects.toMatchObject({
      code: "E_ROOM_FLOOR_THREAD_NOT_FOUND",
    })
  })

  it("resolveRoomFloor includes a non-participant requesters grants in the channel floor", async () => {
    const member = await minimal.person(orgId)
    const outsider = await minimal.person(orgId)
    await minimal.revokeRole(outsider.id, "member")
    await minimal.grantScope(outsider.id, "room:outsider:read")
    const threadId = await seedThread("thread", member.id, [member.id])

    const result = await resolve(threadId, outsider.id)

    expect(result.kind).toBe("channel")
    if (result.kind === "routine_tick") throw new Error("unreachable")
    expect(result.memberGrants).toHaveLength(2)
    expect(sorted(result.memberGrants)).toContainEqual(
      await grantsOf(outsider.id, "room:outsider:read"),
    )
  })
})
