// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Contact groups through the agent (S15, A35), driven through the real chat
// seam: buildToolSet's execute closure, then executeToolCore, with the real
// kernel registrations and handlers.
//
//   - the seven tools: list, create, rename, delete (gated), add, remove, members;
//   - a routine tick (a background frame carrying routineId, the routine's own
//     scopes) can add to a group and read it back (A35);
//   - scope taint (scope-taint.ts): the reads are readOnly; every write names
//     its real table, and the group tables declare their readers
//     (kernel:contacts:read), so on a tainted turn a write runs when every
//     reader holds the turn's scopes and is refused, naming the missing scope,
//     otherwise (rule 6). Reading a contact does not make adding it to a group a
//     same-resource write: the member table is not kernel.contacts.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { checkToolScopeTaint } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "11111111-1111-4111-8111-1111111c7a01"
const USER = "11111111-1111-4111-8111-1111111c7a02"
const READER = "11111111-1111-4111-8111-1111111c7a03"
const CONTACT_A = "11111111-1111-4111-8111-1111111c7a04"
const CONTACT_B = "11111111-1111-4111-8111-1111111c7a05"
const OTHERS_PRIVATE = "11111111-1111-4111-8111-1111111c7a06"

const GROUP_TOOLS = [
  "contacts_groups_list",
  "contacts_group_create",
  "contacts_group_rename",
  "contacts_group_delete",
  "contacts_group_add",
  "contacts_group_remove",
  "contacts_group_members",
]

const userActor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

// What a routine tick runs with: the owner, at the routine's own scopes.
const routineActor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["kernel:contacts:read", "kernel:contacts:write"],
  dimensionGrants: {},
}

function chatFrame(injected: string[] = []): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(injected)
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, turnScopeAccumulator }
}

function routineFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    background: true,
    routineId: crypto.randomUUID(),
    turnScopeAccumulator: createTurnScopeAccumulator(),
  } as RunContext
}

function catalog(frame: RunContext, actor: UserContext = userActor) {
  return buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
}

async function call(
  frame: RunContext,
  tool: string,
  args: Record<string, unknown> = {},
  actor: UserContext = userActor,
): Promise<any> {
  const t = catalog(frame, actor)[`kernel__${tool}`]
  if (!t) throw new Error(`kernel__${tool} is not in the catalog`)
  return runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )
}

function refusedByTaint(r: any): boolean {
  if (r?.code === "E_SCOPE_TAINT_BLOCKED") return true
  const text = typeof r?.error === "string" ? r.error : JSON.stringify(r?.error ?? "")
  return text.includes("E_SCOPE_TAINT_BLOCKED") || text.includes("NOT EXECUTED")
}

async function grant(userId: string, scopes: string[]) {
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

async function memberIds(groupId: string): Promise<string[]> {
  const rows = await sql<{ contact_id: string }[]>`
    SELECT contact_id::text FROM kernel.contact_group_members WHERE segment_id = ${groupId}::uuid`
  return rows.map((r) => r.contact_id).sort()
}

async function createGroupDirect(name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.contact_segments (org_id, name, kind, created_by)
    VALUES (${ORG}, ${name}, 'manual', ${USER}) RETURNING id::text`
  return row.id
}

describe("contact groups through the agent", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Contact Groups Agent Org', 'contact-groups-agent-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash) VALUES
      (${USER}, ${ORG}, 'groups-agent@test.com', 'Groups Agent', 'x'),
      (${READER}, ${ORG}, 'groups-reader@test.com', 'Groups Reader', 'x')
      ON CONFLICT DO NOTHING`
    await grant(USER, ["*"])
    // A colleague who reads contacts (and so reads groups) and nothing else.
    await grant(READER, ["kernel:contacts:read"])
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email, owner_user_id, org_access) VALUES
      (${CONTACT_A}, ${ORG}, '@grp-a', 'Ada Group', 'ada@group.test', NULL, 'editor'),
      (${CONTACT_B}, ${ORG}, '@grp-b', 'Ben Group', 'ben@group.test', NULL, 'editor'),
      (${OTHERS_PRIVATE}, ${ORG}, '@grp-p', 'Pia Private', 'pia@group.test', ${READER}, 'none')
      ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contact_group_members WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contact_segments WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("registers the seven tools with their scopes and taint declarations", () => {
    const def = (n: string) => toolRegistry.get([ORG, "kernel", n])
    for (const n of GROUP_TOOLS) expect(def(n)).toBeDefined()
    expect(def("contacts_groups_list")).toMatchObject({
      readOnly: true,
      requiredScopes: ["kernel:contacts:read"],
    })
    expect(def("contacts_group_members")).toMatchObject({
      readOnly: true,
      requiredScopes: ["kernel:contacts:read"],
      readsFromTable: "kernel.contact_segments",
      targetRowParam: "groupId",
    })
    for (const n of ["contacts_group_create", "contacts_group_rename"]) {
      expect(def(n)).toMatchObject({
        requiredScopes: ["kernel:contacts:write"],
        writesToTable: "kernel.contact_segments",
        sinkReadScope: "kernel:contacts:read",
      })
      expect(def(n)?.gated).toBeUndefined()
    }
    for (const n of ["contacts_group_add", "contacts_group_remove"]) {
      expect(def(n)).toMatchObject({
        requiredScopes: ["kernel:contacts:write"],
        writesToTable: "kernel.contact_group_members",
        sinkReadScope: "kernel:contacts:read",
      })
      expect(def(n)?.gated).toBeUndefined()
    }
    expect(def("contacts_group_delete")).toMatchObject({
      gated: true,
      writesToTable: "kernel.contact_segments",
      targetRowParam: "groupId",
    })
  })

  it("create, add, members, rename, remove, list: each tool does what it says", async () => {
    const frame = chatFrame()
    const created = await call(frame, "contacts_group_create", { name: "Trade show leads" })
    expect(created).toMatchObject({ name: "Trade show leads", memberCount: 0 })
    const groupId = created.id as string

    const dup = await call(frame, "contacts_group_create", { name: "trade SHOW leads" })
    expect(JSON.stringify(dup)).toContain("already exists")

    const added = await call(frame, "contacts_group_add", {
      groupId,
      contactIds: [CONTACT_A, CONTACT_B, OTHERS_PRIVATE],
    })
    // The acting user cannot see the colleague's private contact: not added.
    expect(added).toMatchObject({ added: 2, alreadyMembers: 0, notFound: [OTHERS_PRIVATE] })
    expect(await memberIds(groupId)).toEqual([CONTACT_A, CONTACT_B].sort())

    const members = await call(frame, "contacts_group_members", { groupId })
    expect(members.group).toEqual({ id: groupId, name: "Trade show leads" })
    expect(members.items.map((c: { id: string }) => c.id).sort()).toEqual(
      [CONTACT_A, CONTACT_B].sort(),
    )
    expect(members.totalCount).toBe(2)

    const renamed = await call(frame, "contacts_group_rename", { groupId, name: "Show leads" })
    expect(renamed).toMatchObject({ id: groupId, name: "Show leads", memberCount: 2 })

    const removed = await call(frame, "contacts_group_remove", { groupId, contactIds: [CONTACT_B] })
    expect(removed).toMatchObject({ removed: 1, notMembers: 0, notFound: [] })
    expect(await memberIds(groupId)).toEqual([CONTACT_A])

    const listed = await call(frame, "contacts_groups_list")
    expect(listed.groups).toContainEqual({ id: groupId, name: "Show leads", memberCount: 1 })
  })

  it("delete is gated: it parks an approval and the group is still there", async () => {
    const groupId = await createGroupDirect("To delete")
    const r = await call(chatFrame(), "contacts_group_delete", { groupId })
    expect(r?.status).toBe("pending_approval")
    expect(typeof r?.approvalRequestId).toBe("string")
    const [still] = await sql`SELECT 1 FROM kernel.contact_segments WHERE id = ${groupId}::uuid`
    expect(still).toBeDefined()

    // An unknown group is refused at staging, no approval is raised.
    const missing = await call(chatFrame(), "contacts_group_delete", {
      groupId: "11111111-1111-4111-8111-1111111c7aff",
    })
    expect(JSON.stringify(missing)).toContain("NOT_FOUND")
  })

  it("A35: a routine tick can add to a group and read it back", async () => {
    const groupId = await createGroupDirect("Routine group")
    const frame = routineFrame()
    const tools = catalog(frame, routineActor)
    for (const n of GROUP_TOOLS) expect(tools[`kernel__${n}`]).toBeDefined()

    // The routine first reads contacts (its turn is now tainted by kernel:contacts:read) ...
    const search = await call(frame, "contacts_search", { query: "Group" }, routineActor)
    expect(search.items.length).toBeGreaterThan(0)
    expect(frame.turnScopeAccumulator?.snapshot()).toContain("kernel:contacts:read")

    // ... then adds to the group and reads it back.
    const added = await call(
      frame,
      "contacts_group_add",
      { groupId, contactIds: [CONTACT_A] },
      routineActor,
    )
    expect(refusedByTaint(added)).toBe(false)
    expect(added).toMatchObject({ added: 1 })
    const members = await call(frame, "contacts_group_members", { groupId }, routineActor)
    expect(members.items.map((c: { id: string }) => c.id)).toEqual([CONTACT_A])
    const listed = await call(frame, "contacts_groups_list", {}, routineActor)
    expect(listed.groups.map((g: { id: string }) => g.id)).toContain(groupId)
  })

  // Scope taint. The same org, seed and registrations as above.
  const TAINT_OTHER = "invoicing:documents:read"

  it("the reads are readOnly: they run on any tainted turn", async () => {
    const groupId = await createGroupDirect("Taint reads")
    const frame = chatFrame([TAINT_OTHER])
    expect(refusedByTaint(await call(frame, "contacts_groups_list"))).toBe(false)
    const members = await call(frame, "contacts_group_members", { groupId })
    expect(refusedByTaint(members)).toBe(false)
    expect(members.group.id).toBe(groupId)
  })

  it("a turn tainted only by contacts it read may add a read contact: every group reader holds the taint", async () => {
    const groupId = await createGroupDirect("Taint contacts only")
    const frame = chatFrame()
    const read = await call(frame, "contacts_read", { contactId: CONTACT_A })
    expect(read?.contact?.id).toBe(CONTACT_A)
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual(["kernel:contacts:read"])

    const added = await call(frame, "contacts_group_add", { groupId, contactIds: [CONTACT_A] })
    expect(refusedByTaint(added)).toBe(false)
    expect(added).toMatchObject({ added: 1 })
    // Same rule for another contact the turn never read, and for creating a group.
    const addedB = await call(frame, "contacts_group_add", { groupId, contactIds: [CONTACT_B] })
    expect(addedB).toMatchObject({ added: 1 })
    expect(
      refusedByTaint(await call(frame, "contacts_group_create", { name: "Made tainted" })),
    ).toBe(false)
  })

  it("a turn tainted by data a group reader lacks never writes inline, even for the contact it read: it parks for approval", async () => {
    const groupId = await createGroupDirect("Taint invoicing")
    const frame = chatFrame([TAINT_OTHER])
    const read = await call(frame, "contacts_read", { contactId: CONTACT_A })
    expect(read?.contact?.id).toBe(CONTACT_A)
    // The read filed an origin for kernel.contacts, which the member table is not.
    expect(frame.turnScopeAccumulator?.originRows()).toEqual({ "kernel.contacts": [CONTACT_A] })

    // READER holds kernel:contacts:read but not the invoicing scope, so the write parks for
    // a person holding it (scope-taint.ts, rule 8), and its card says why.
    const added = await call(frame, "contacts_group_add", { groupId, contactIds: [CONTACT_A] })
    expect(refusedByTaint(added)).toBe(false)
    expect(added).toMatchObject({ blocked: true, status: "pending_approval" })
    expect(JSON.stringify(added)).toContain(
      "some people who can read kernel.contact_group_members cannot see",
    )
    expect(await memberIds(groupId)).toEqual([])

    const created = await call(frame, "contacts_group_create", { name: "Leaky" })
    expect(created).toMatchObject({ blocked: true, status: "pending_approval" })
    const renamed = await call(frame, "contacts_group_rename", { groupId, name: "Leaky" })
    expect(renamed).toMatchObject({ blocked: true, status: "pending_approval" })
  })

  it("the bridge defers the declared-readers writes to the dispatch and refuses none of the reads", () => {
    const def = (n: string) => toolRegistry.get([ORG, "kernel", n]) as never
    const tainted = [TAINT_OTHER]
    for (const n of ["contacts_groups_list", "contacts_group_members"]) {
      expect(checkToolScopeTaint(tainted, def(n), { args: {} })).toBeNull()
    }
    for (const n of ["contacts_group_create", "contacts_group_add", "contacts_group_remove"]) {
      // Plain rule: refused (no enforcing sink, no origin) ...
      expect(checkToolScopeTaint(tainted, def(n), { args: {} })?.code).toBe("E_SCOPE_TAINT_BLOCKED")
      // ... the bridge passes it on to the dispatch, which judges its readers.
      expect(
        checkToolScopeTaint(tainted, def(n), { args: {}, deferGatedToDispatch: true }),
      ).toBeNull()
    }
  })
})
