// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * An agent's approval card quotes the page it changes, so only who can read the
 * page sees it: no card for a page only its owner reads, the owner's card alone
 * for a page shared with named people, the organization's card as ever otherwise.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "drizzle-orm"
import {
  audienceOfCreateParams,
  audienceOfFacts,
  knowledgeApprovalOwner,
} from "~/apps/knowledge/approval-audience"
import { createKnowledgeCollection } from "~/apps/knowledge/collections"
import {
  createKnowledgeDocument,
  type KnowledgeActor,
  knowledgeActorFromContext,
  setDocumentSharing,
} from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { WebSocketManager } from "~/infra/websocket"
import { bindExistingRunningWatchDoc } from "~/modules/agent/tools/skills-routines-tools"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { decideApproval } from "~/modules/approvals/decide"
import { listApprovals } from "~/modules/approvals/list"
import { approvalResourceOwnerRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let admin: string
let owner: string
let editor: string
let approver: string
let collectionId: string

const SECRET = "Redundancy plan for the Lyon site"

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  admin = (await minimal.orgAdmin(orgId)).id
  const member = async (name: string, scopes: string[] = []) => {
    const p = await minimal.person(orgId, { name })
    await minimal.assignRole(p.id, "Full Member")
    for (const s of ["knowledge:documents:archive", "kernel:approvals:read", ...scopes]) {
      await minimal.grantScope(p.id, s)
    }
    await withPrivilegedDb(orgId, "test-sensitivity", (tx) =>
      tx.execute(
        sql.raw(
          insertSql(`${schemaRef("kernel")}.user_dimension_grants`, {
            user_id: p.id,
            org_id: orgId,
            dimension_key: "knowledge:sensitivity",
            dimension_values: { raw: `'["internal","confidential"]'::jsonb` },
          }),
        ),
      ),
    )
    return p.id
  }
  owner = await member("Owner")
  editor = await member("Editor")
  approver = await member("Approver", ["knowledge:approve", "kernel:approvals:admin"])
  collectionId = await as(
    owner,
    async (tx, a) =>
      (await createKnowledgeCollection(tx, { name: "Plans", ownerUserId: null }, a)).id,
  )
})
afterAll(releaseTestLock)

async function held(userId: string): Promise<ActorContext> {
  const perms = await withPrivilegedDb(orgId, "test-held", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    orgId,
    userId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  } as ActorContext
}

async function as<T>(
  userId: string,
  fn: (tx: RlsClient, a: KnowledgeActor) => Promise<T>,
): Promise<T> {
  const ctx = await held(userId)
  return withRlsContext(ctx, (tx) => fn(tx, knowledgeActorFromContext(ctx as never)))
}

async function page(
  title: string,
  opts: { access?: "none" | "editor"; sharedWith?: string[] } = {},
): Promise<string> {
  const id = await as(
    owner,
    async (tx, a) =>
      (
        await createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title,
            body: SECRET,
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            orgAccess: opts.access ?? "none",
            verifyNow: false,
          },
          a,
          [],
        )
      ).id,
  )
  if (opts.sharedWith) {
    const shares = opts.sharedWith.map((userId) => ({ userId, role: "editor" as const }))
    await as(owner, (tx, a) =>
      setDocumentSharing(tx, id, { orgAccess: "none", editScope: null, shares }, a),
    )
  }
  return id
}

type Outcome = {
  status?: string
  approval_id?: string
  id?: string
  error?: { code: string }
}

async function agent(
  userId: string,
  tool: "create" | "update" | "archive",
  params: Record<string, unknown>,
): Promise<Outcome> {
  const res = await executeTool<Outcome>({
    toolName: `knowledge:${tool}`,
    orgId,
    actor: await held(userId),
    params,
    threadId: await minimal.thread(orgId, userId, { title: `Agent ${crypto.randomUUID()}` }),
    origin: "in-app-agent",
    stepBundleId: null,
  } as never)
  expect(res.blocked).toBeUndefined()
  return res.data as Outcome
}

async function requests(): Promise<
  Array<{ id: string; resource_owner_id: string | null; notify: string[]; summary: unknown }>
> {
  return extractRows(
    await withPrivilegedDb(orgId, "test-approval-rows", (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, resource_owner_id::text AS resource_owner_id,
               notify_user_ids AS notify, to_jsonb(r) AS summary
          FROM kernel.approval_requests r WHERE org_id = ${orgId}::uuid
         ORDER BY created_at`),
    ),
  )
}

async function stored(id: string): Promise<{ body: string; revision: number; archived: boolean }> {
  const [row] = extractRows<{ body: string; revision: number; archived: boolean }>(
    await withPrivilegedDb(orgId, "test-stored", (tx) =>
      tx.execute(sql`
        SELECT body, revision, archived_at IS NOT NULL AS archived
          FROM ${sql.raw(schemaRef("app_knowledge"))}.documents WHERE id = ${id}::uuid`),
    ),
  )
  if (!row) throw new Error("no such page")
  return row
}

/** Everything `userId` can see of approvals: rows, list, feed, socket frames. */
async function seenBy(userId: string, requestId: string): Promise<string> {
  const ctx = await held(userId)
  const scopes = (ctx as { scopes: string[] }).scopes
  return withRlsContext(ctx, async (tx) => {
    const rows = extractRows(
      await tx.execute(sql`SELECT to_jsonb(r) AS r FROM kernel.approval_requests r
                            WHERE id = ${requestId}::uuid`),
    )
    const list = (await listApprovals(tx, { orgId, userId, scopes })).filter((r) =>
      JSON.stringify(r).includes(requestId),
    )
    const feed = (await computeApprovalAttentionItems(tx, orgId, userId)).filter((i) =>
      JSON.stringify(i).includes(requestId),
    )
    return JSON.stringify({ rows, list, feed })
  })
}

describe("who the page is for", () => {
  it("by its scope, its access, its grants and its people", () => {
    const base = {
      documentScope: "organization",
      orgAccess: "none",
      ownerUserId: "a",
      createdBy: "a",
      othersGranted: false,
    }
    expect(audienceOfFacts({ ...base, documentScope: "personal" })).toBe("private")
    expect(audienceOfFacts(base)).toBe("private")
    expect(audienceOfFacts({ ...base, ownerUserId: null })).toBe("private")
    expect(audienceOfFacts({ ...base, ownerUserId: "b" })).toBe("restricted")
    expect(audienceOfFacts({ ...base, othersGranted: true })).toBe("restricted")
    for (const orgAccess of ["viewer", "editor"]) {
      expect(audienceOfFacts({ ...base, orgAccess })).toBe("org")
    }
  })

  it("a create's, from the params it will use", () => {
    const of = (p: Record<string, unknown>) => audienceOfCreateParams(p, "a")
    expect(of({ documentScope: "personal" })).toBe("private")
    expect(of({})).toBe("org")
    expect(of({ sensitivity: "internal" })).toBe("org")
    expect(of({ sensitivity: "confidential" })).toBe("private")
    expect(of({ sensitivity: "confidential", shareWithRoles: [{ roleId: "r" }] })).toBe(
      "restricted",
    )
    expect(of({ orgAccess: "none" })).toBe("private")
    expect(of({ sensitivity: "restricted", orgAccess: "viewer" })).toBe("org")
    expect(of({ orgAccess: "none", ownerUserId: "b" })).toBe("restricted")
  })
})

/** A create whose page only named people read, as the agent of `userId` asks it. */
async function restrictedCreate(userId: string, title: string): Promise<Outcome> {
  const [role] = extractRows<{ id: string }>(
    await withPrivilegedDb(orgId, "test-role", (tx) =>
      tx.execute(
        sql`SELECT id::text AS id FROM kernel.roles WHERE org_id = ${orgId}::uuid AND name = 'knowledge.curator'`,
      ),
    ),
  )
  return agent(userId, "create", {
    title,
    body: SECRET,
    documentScope: "organization",
    sensitivity: "confidential",
    collectionId,
    shareWithRoles: [{ roleId: role?.id, access: "viewer" }],
  })
}

const orgCreate = (userId: string, title: string) =>
  agent(userId, "create", {
    title,
    body: "For everyone",
    documentScope: "organization",
    sensitivity: "internal",
    collectionId,
  })

async function pageTitled(title: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await withPrivilegedDb(orgId, "test-titled", (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM ${sql.raw(schemaRef("app_knowledge"))}.documents
         WHERE org_id = ${orgId}::uuid AND title = ${title} AND archived_at IS NULL`),
    ),
  )
  return row?.n ?? 0
}

describe("an agent's change of a page only its owner reads", () => {
  it("agent updates my private page: written, no approval row; archive the same", async () => {
    const id = await page("Mine alone")
    const before = (await requests()).length
    const out = await agent(owner, "update", { id, revision: 1, body: "changed by my agent" })
    expect(out.status).not.toBe("pending_approval")
    expect((await stored(id)).body).toBe("changed by my agent")
    await agent(owner, "archive", { id })
    expect((await stored(id)).archived).toBe(true)
    expect((await requests()).length).toBe(before)
  })

  it("agent creates what would be written into my private page: written there, no approval row", async () => {
    const title = "Mine alone, written again"
    const id = await page(title)
    const before = (await requests()).length
    const out = await orgCreate(owner, title)
    expect(out.status).not.toBe("pending_approval")
    expect((await stored(id)).body).toBe("For everyone")
    expect(await pageTitled(title)).toBe(1)
    expect((await requests()).length).toBe(before)
  })
})

describe("an agent's page for named people", () => {
  it("parks for the requester: a holder of knowledge:approve and of kernel:approvals:admin, an admin and the notified set see no row, no title, no body; the requester sees and decides it", async () => {
    const frames: string[] = []
    const socket = {
      readyState: 1,
      send: (m: string) => {
        frames.push(m)
      },
    }
    const manager = new WebSocketManager({
      eval: async () => 0,
      zadd: async () => 0,
      expire: async () => 1,
      incr: async () => 1,
      exists: async () => 1,
      set: async () => "OK",
      get: async () => null,
      del: async () => 0,
      sadd: async () => 1,
      srem: async () => 0,
      smembers: async () => [],
      mget: async () => [],
      zrangebyscore: async () => [],
    } as never)
    manager.addConnection(approver, socket as never, (await held(approver)).scopes ?? [], orgId)
    manager.addConnection(admin, socket as never, ["*"], orgId)

    const title = `Restricted ${SECRET}`
    const out = await restrictedCreate(editor, title)
    expect(out.status).toBe("pending_approval")
    const requestId = String(out.approval_id)
    const row = (await requests()).find((r) => r.id === requestId)
    expect({ owner: row?.resource_owner_id, notify: row?.notify }).toEqual({
      owner: editor,
      notify: [editor],
    })
    expect(JSON.stringify(row?.summary)).toContain(
      "Only the people this page is shared with see it",
    )

    for (const bystander of [approver, admin]) {
      expect(JSON.parse(await seenBy(bystander, requestId))).toEqual({
        rows: [],
        list: [],
        feed: [],
      })
    }
    const events = extractRows<{ payload: never }>(
      await withPrivilegedDb(orgId, "test-approval-events", (tx) =>
        tx.execute(sql`SELECT payload FROM kernel.pending_events
                        WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'approval_request'
                          AND payload->>'entityId' = ${requestId}`),
      ),
    )
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) await manager.bufferAndBroadcast(event.payload)
    expect(frames).toEqual([])

    expect(await seenBy(editor, requestId)).toContain("Redundancy plan")
    const decide = async (userId: string) =>
      decideApproval({
        orgId,
        actor: (await held(userId)) as never,
        requestId,
        decision: "approve",
      })
    await expect(decide(approver)).rejects.toThrow()
    expect(await pageTitled(title)).toBe(0)
    await decide(editor)
    expect(await pageTitled(title)).toBe(1)
  })

  it("a create that would be written into an organization page is the organization's card, whatever it claims", async () => {
    const id = await page("Pricing handbook", { access: "editor" })
    const out = await restrictedCreate(editor, "Pricing handbook")
    expect(out.status).toBe("pending_approval")
    const row = (await requests()).find((r) => r.id === out.approval_id)
    expect(row?.resource_owner_id).toBeNull()
    expect((await stored(id)).body).toBe(SECRET)
  })

  it("an update or an archive that a policy gates is the page owner's to decide", async () => {
    const ask = (tool: string, id: string, requestedBy: string) =>
      knowledgeApprovalOwner(tool, { id }, { orgId, requestedBy })
    const restricted = await page("Policy restricted", { sharedWith: [editor] })
    const mine = await page("Policy private")
    const open = await page("Policy open", { access: "editor" })
    for (const tool of ["update", "archive"]) {
      const decl = approvalResourceOwnerRegistry.get([orgId, "knowledge", tool])
      expect(decl && "resolveOwner" in decl).toBe(true)
      expect(await ask(tool, restricted, editor)).toBe(owner)
      expect(await ask(tool, mine, owner)).toBe(owner)
      expect(await ask(tool, open, editor)).toBeNull()
    }
    // An owner who left decides nothing: the requester does.
    await withPrivilegedDb(orgId, "test-left", (tx) =>
      tx.execute(sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${owner}::uuid`),
    )
    try {
      expect(await ask("update", restricted, editor)).toBe(editor)
    } finally {
      await withPrivilegedDb(orgId, "test-back", (tx) =>
        tx.execute(sql`UPDATE kernel.users SET status = 'active' WHERE id = ${owner}::uuid`),
      )
    }
  })

  it("resolver failure -> requester only", async () => {
    const permissions = await import("~/modules/permissions/permissions")
    const broken = spyOn(permissions, "loadEffectivePermissions").mockImplementation(async () => {
      throw new Error("down")
    })
    try {
      expect(
        await knowledgeApprovalOwner("create", { title: "x" }, { orgId, requestedBy: editor }),
      ).toBe(editor)
    } finally {
      broken.mockRestore()
    }
    expect(
      await knowledgeApprovalOwner(
        "update",
        { id: crypto.randomUUID() },
        { orgId, requestedBy: editor },
      ),
    ).toBe(editor)
  })
})

describe("an agent's organization page", () => {
  it("organisation page: card as today for the same holders", async () => {
    const title = "Everyone's handbook"
    const out = await orgCreate(editor, title)
    expect(out.status).toBe("pending_approval")
    const row = (await requests()).find((r) => r.id === out.approval_id)
    expect(row?.resource_owner_id).toBeNull()
    expect(row?.notify).toContain(approver)
    expect(JSON.stringify(row?.summary)).toContain("Scope: organization (visible to the whole org)")
    expect(await seenBy(approver, String(out.approval_id))).toContain(title)
    await decideApproval({
      orgId,
      actor: (await held(approver)) as never,
      requestId: String(out.approval_id),
      decision: "approve",
    })
    expect(await pageTitled(title)).toBe(1)
  })
})

describe("a routine prompt", () => {
  it("private titles never enter a routine prompt", async () => {
    await page("Competitor Firmware Secret Watch")
    const prompt = "Watch competitor firmware and keep the secret watch document up to date"
    expect(await bindExistingRunningWatchDoc(orgId, prompt)).toBeNull()
    await page("Competitor Firmware Public Watch", { access: "editor" })
    const bound = await bindExistingRunningWatchDoc(orgId, prompt)
    expect(bound).toContain("Competitor Firmware Public Watch")
    expect(bound).not.toContain("Secret")
  })
})
