// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Threat-table regression guard (spec-security.md, "Buzz failure mode:
// agent-as-member reads full channel history"): an agent's own read of a
// channel's history for context assembly is governed by the room's floor at
// the time it reads, never by the agent's own (typically wider) ceiling and
// never by the requester's raw grants.
//
// Everything here is real: a real org, real users, real grant rows read
// through the production permissions path, real threads of each room kind,
// real messages carrying real required_scopes and disclosure_list values, and
// the real messages SELECT policy for the human read path the context read
// must agree with. The turn's scope comes from 2a's own primitives
// (resolveRoomFloor, computeEffectiveScopeForTurn), and the filter is T30's
// filterByVisibility, unmodified.
//
// What is NOT exercised here: modules/agent/context/context.ts is frozen for 2b, so
// nothing in production calls filterByVisibility yet. This test drives the
// exact composition slice 3 is specified to wire in (floor -> effective scope
// -> viewer -> filter), so the mechanism is proven; the call site is not.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, asc, eq, isNull } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import { computeEffectiveScopeForTurn } from "~/modules/agent/scopes/effective-scope"
import { resolveRoomFloor } from "~/modules/agent/scopes/room-floor"
import { KERNEL_EVERY_MEMBER_SCOPES } from "~/modules/permissions/every-member-scopes"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { filterByVisibility, type VisibilityViewer } from "~/services/security/visibility"

const FINANCE = "finance:invoices:read"
const SHARED = "ops:tickets:read"

/** The agent's own ceiling. Wider than any room floor below, on purpose. */
const CEILING = [FINANCE, SHARED]

const ORG_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

// The human the turn answers. Holds FINANCE, so the finance-tagged message is
// readable in this person's own UI: the whole point is that the AGENT still
// does not get it in a room where a member lacks that scope.
const REQUESTER = crypto.randomUUID()
// A second human in the channel, holding SHARED only. This person is the floor.
const TEAMMATE = crypto.randomUUID()
// A third human holding nothing at all, used for the empty-floor room.
const BARE = crypto.randomUUID()

const CHANNEL = crypto.randomUUID() // type 'thread': requester plus teammate
const DM = crypto.randomUUID() // type 'agent_chat': the requester alone
const ROUTINE = crypto.randomUUID() // type 'routine': no requester, no floor
const BARE_ROOM = crypto.randomUUID() // type 'thread': requester plus a grantless member

/** Fixture key -> message id, and the reverse, so assertions read as keys. */
const idByKey = new Map<string, string>()
const keyById = new Map<string, string>()

function idOf(key: string): string {
  const id = idByKey.get(key)
  if (!id) throw new Error(`fixture message ${key} was not inserted`)
  return id
}

const sorted = (values: string[]) => [...values].sort()

async function addUser(id: string, name: string): Promise<void> {
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${id}, ${ORG_ID}, ${`ctx-floor-${name}-${tag}@test.com`}, ${name}, 'x')`
}

async function grant(userId: string, scope: string): Promise<void> {
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${userId}, ${ORG_ID}, ${scope})`
}

async function addThread(
  id: string,
  handle: string,
  type: string,
  members: string[],
): Promise<void> {
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${id}, ${ORG_ID}, ${`${handle}-${tag}`}, ${type}, ${REQUESTER})`
  for (const userId of members) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${id}, ${userId}, ${ORG_ID})`
  }
}

async function addMessage(
  key: string,
  threadId: string,
  requiredScopes: string[],
  disclosureList: string[] | null,
): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, content, required_scopes, disclosure_list)
    VALUES (${threadId}, ${ORG_ID}, ${REQUESTER}, ${`ctx-floor-${key}`},
      ${requiredScopes}::text[], ${disclosureList}::uuid[])
    RETURNING id`
  const id = row?.id ?? ""
  idByKey.set(key, id)
  keyById.set(id, key)
}

/**
 * The room's history as context assembly must read it: privileged, because
 * RLS on kernel.messages answers for the ACTOR, and the question here is what
 * the ROOM's floor admits. Narrowed to the visibility columns plus the id.
 */
async function historyOf(threadId: string) {
  return withPrivilegedDb(ORG_ID, "test-context-floor-history", (tx) =>
    tx
      .select({
        id: messages.id,
        requiredScopes: messages.requiredScopes,
        disclosureList: messages.disclosureList,
      })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
      .orderBy(asc(messages.createdAt), asc(messages.id)),
  )
}

/** 2a's own turn computation, on real rows: the room floor met by the ceiling. */
async function effectiveScopeFor(threadId: string) {
  return withPrivilegedDb(ORG_ID, "test-context-floor-effective-scope", (tx) =>
    computeEffectiveScopeForTurn(tx, ORG_ID, threadId, REQUESTER, CEILING),
  )
}

/** A human's real grants, through the production permissions read path. */
async function rawGrantsOf(userId: string): Promise<string[]> {
  return withPrivilegedDb(
    ORG_ID,
    "test-context-floor-grants",
    async (tx) => (await loadEffectivePermissions(tx, userId, ORG_ID)).scopes,
  )
}

/**
 * The viewer a turn's context assembly builds. THE GRANTS ARE THE TURN'S
 * EFFECTIVE SCOPE, never the actor's raw grants: that single choice is what
 * this whole file exists to pin.
 */
async function contextViewer(threadId: string): Promise<VisibilityViewer> {
  const { effectiveScope } = await effectiveScopeFor(threadId)
  return { userId: REQUESTER, grants: effectiveScope }
}

/** The fixture keys of the messages a turn in this room may put in its prompt. */
async function contextKeys(threadId: string): Promise<string[]> {
  const kept = filterByVisibility(await historyOf(threadId), await contextViewer(threadId))
  return kept.map((row) => keyById.get(row.id) ?? row.id)
}

/** The fixture keys a human actually reads in the UI, through the real RLS policy. */
async function uiKeys(userId: string, threadId: string): Promise<string[]> {
  const ctx: UserContext = {
    actorType: "user",
    userId,
    orgId: ORG_ID,
    scopes: await rawGrantsOf(userId),
    dimensionGrants: {},
  }
  const rows = await withRlsContext(ctx, (tx) =>
    tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
      .orderBy(asc(messages.createdAt), asc(messages.id)),
  )
  return rows.map((row) => keyById.get(row.id) ?? row.id)
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'CtxFloorOrg', ${`ctx-floor-${tag}`})`
  await addUser(REQUESTER, "requester")
  await addUser(TEAMMATE, "teammate")
  await addUser(BARE, "bare")

  await grant(REQUESTER, FINANCE)
  await grant(REQUESTER, SHARED)
  await grant(TEAMMATE, SHARED)
  // BARE holds nothing, and no role is attached to any of them, so
  // loadEffectivePermissions returns exactly these rows.

  await addThread(CHANNEL, "ctx-floor-channel", "thread", [REQUESTER, TEAMMATE])
  await addThread(DM, "ctx-floor-dm", "agent_chat", [REQUESTER])
  await addThread(ROUTINE, "ctx-floor-routine", "routine", [REQUESTER])
  await addThread(BARE_ROOM, "ctx-floor-bare", "thread", [REQUESTER, BARE])

  await addMessage("open", CHANNEL, [], null)
  await addMessage("shared", CHANNEL, [SHARED], null)
  await addMessage("finance", CHANNEL, [FINANCE], null)
  await addMessage("finance-disclosed-requester", CHANNEL, [FINANCE], [REQUESTER])
  await addMessage("finance-disclosed-teammate", CHANNEL, [FINANCE], [TEAMMATE])

  await addMessage("dm-open", DM, [], null)
  await addMessage("dm-finance", DM, [FINANCE], null)

  await addMessage("tick-open", ROUTINE, [], null)
  await addMessage("tick-finance", ROUTINE, [FINANCE], null)

  await addMessage("bare-open", BARE_ROOM, [], null)
  await addMessage("bare-shared", BARE_ROOM, [SHARED], null)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("an agent's context read of a room's history is floor gated", () => {
  it("the room floor and the turn's effective scope come from the real member grants", async () => {
    const floor = await withPrivilegedDb(ORG_ID, "test-context-floor-resolve", (tx) =>
      resolveRoomFloor(tx, ORG_ID, CHANNEL, REQUESTER),
    )
    expect(floor.kind).toBe("channel")
    if (floor.kind === "routine_tick") throw new Error("unreachable")
    // Both humans in the room, with the grants their own rows carry.
    expect(floor.memberGrants.map(sorted).sort()).toEqual(
      [
        sorted([FINANCE, SHARED, ...KERNEL_EVERY_MEMBER_SCOPES]),
        sorted([SHARED, ...KERNEL_EVERY_MEMBER_SCOPES]),
      ].sort(),
    )

    const { effectiveScope, withheld } = await effectiveScopeFor(CHANNEL)
    // The teammate lacks FINANCE, so the room floors the agent's ceiling.
    expect(sorted(effectiveScope)).toEqual([SHARED])
    expect(withheld).toEqual([FINANCE])
  })

  it("filterByVisibility applied with the room's floor excludes a finance-scoped message even though the agent's own ceiling includes finance", async () => {
    expect(CEILING).toContain(FINANCE)

    const keys = await contextKeys(CHANNEL)

    // The finance-tagged message never reaches the agent's prompt.
    expect(keys).not.toContain("finance")
    // What survives: the untagged row and the one every member holds, plus the
    // row disclosed to the very person the turn answers (see below).
    expect(sorted(keys)).toEqual(sorted(["open", "shared", "finance-disclosed-requester"]))
  })

  it("a message only the requester can see in the UI does not enter the agent's context", async () => {
    // The real RLS policy, on the requester's own grants: they DO read it.
    expect(await uiKeys(REQUESTER, CHANNEL)).toContain("finance")
    // The teammate does not, which is exactly why the room's floor excludes it.
    expect(await uiKeys(TEAMMATE, CHANNEL)).not.toContain("finance")
    // So the agent, acting for the requester in that room, does not get it.
    expect(await contextKeys(CHANNEL)).not.toContain("finance")
  })

  it("every scope gated row the agent keeps is a row the whole room can already read", async () => {
    const keys = await contextKeys(CHANNEL)
    const teammateKeys = await uiKeys(TEAMMATE, CHANNEL)
    const requesterKeys = await uiKeys(REQUESTER, CHANNEL)
    // A disclosure is per person and cannot be a room-wide claim, so it is
    // accounted for separately in its own case below.
    for (const key of keys.filter((k) => !k.startsWith("finance-disclosed"))) {
      expect({ key, readableByTheRoom: teammateKeys.includes(key) }).toEqual({
        key,
        readableByTheRoom: true,
      })
    }
    for (const key of keys) {
      expect({ key, readableByTheRequester: requesterKeys.includes(key) }).toEqual({
        key,
        readableByTheRequester: true,
      })
    }
  })

  it("a disclosure listed row is admitted for the person it was disclosed to, and nobody else", async () => {
    const keys = await contextKeys(CHANNEL)
    // The turn answers the requester, so the viewer id is the requester's: a
    // row Share anyway disclosed to them is a row they already read in the UI.
    expect(await uiKeys(REQUESTER, CHANNEL)).toContain("finance-disclosed-requester")
    expect(keys).toContain("finance-disclosed-requester")
    // A row disclosed to the OTHER member is not the requester's to read, and
    // the scope branch still refuses it: the disclosure is not a room-wide key.
    expect(keys).not.toContain("finance-disclosed-teammate")
    expect(await uiKeys(REQUESTER, CHANNEL)).toContain("finance-disclosed-teammate")
  })

  it("a DM is floored by the requester alone, so their own finance row is context", async () => {
    const { effectiveScope, withheld } = await effectiveScopeFor(DM)
    expect(sorted(effectiveScope)).toEqual(sorted([FINANCE, SHARED]))
    expect(withheld).toEqual([])

    // Nobody else is in the room to floor it, so the requester's own scoped
    // history is exactly what the turn may read.
    expect(sorted(await contextKeys(DM))).toEqual(sorted(["dm-open", "dm-finance"]))
  })

  it("a routine tick has no requester and no floor, so the ceiling governs", async () => {
    const { effectiveScope, withheld } = await effectiveScopeFor(ROUTINE)
    expect(sorted(effectiveScope)).toEqual(sorted(CEILING))
    expect(withheld).toEqual([])

    expect(sorted(await contextKeys(ROUTINE))).toEqual(sorted(["tick-open", "tick-finance"]))
  })

  it("an untagged row survives an empty effective scope, and nothing else does", async () => {
    const { effectiveScope, withheld } = await effectiveScopeFor(BARE_ROOM)
    // A member holding nothing floors the turn to nothing.
    expect(effectiveScope).toEqual([])
    expect(sorted(withheld)).toEqual(sorted(CEILING))

    // An empty requiredScopes array is a positive assertion that the row
    // carries no scoped data, so it is context for every turn, grants or not.
    expect(await contextKeys(BARE_ROOM)).toEqual(["bare-open"])
  })

  it("built from the actor's raw grants instead of the turn's effective scope, the same history leaks the finance message", async () => {
    // The discriminating input, stated as a counterfactual so this file fails
    // the day a caller passes the wrong viewer. The requester's raw grants and
    // the turn's effective scope genuinely differ here.
    const rawGrants = await rawGrantsOf(REQUESTER)
    const { effectiveScope } = await effectiveScopeFor(CHANNEL)
    expect(rawGrants).toContain(FINANCE)
    expect(effectiveScope).not.toContain(FINANCE)

    const history = await historyOf(CHANNEL)
    const leaked = filterByVisibility(history, { userId: REQUESTER, grants: rawGrants })
    const floored = filterByVisibility(history, { userId: REQUESTER, grants: effectiveScope })

    // Raw grants: the Buzz failure mode, the agent reads the whole room.
    expect(leaked.map((row) => keyById.get(row.id))).toContain("finance")
    // Effective scope: the room's floor holds.
    expect(floored.map((row) => keyById.get(row.id))).not.toContain("finance")
  })

  it("the agent ceiling alone never admits a message the room floored away", async () => {
    // The other half of the same discriminator: the ceiling is wider than the
    // floor, and a viewer built from it reads the finance row.
    const history = await historyOf(CHANNEL)
    const byCeiling = filterByVisibility(history, { userId: REQUESTER, grants: CEILING })

    expect(byCeiling.map((row) => keyById.get(row.id))).toContain("finance")
    expect(await contextKeys(CHANNEL)).not.toContain("finance")
    expect(idOf("finance")).not.toBe("")
  })
})
