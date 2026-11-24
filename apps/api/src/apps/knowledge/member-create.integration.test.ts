// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a Full Member of an organization made the way Liaison Cloud makes one can
 * create, with the permissions that role carries and no dimension grant: a shared
 * page, an "Only me" page, a page in a folder, alone or through their agent. A
 * confidential or restricted page still needs the sensitivity grant.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { app } from "~/app"
import { createKnowledgeCollection } from "~/apps/knowledge/collections"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { knowledgeActorFromContext } from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { decideApproval } from "~/modules/approvals/decide"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock, truncateOrgTables } from "~/tests/route-test-setup"

let orgId: string
let admin: minimal.Session
let member: minimal.Session
let shelf: string

beforeAll(async () => {
  await acquireTestLock()
  await truncateOrgTables()
  initializedOrgRuntimes.clear()
  orgId = (await ensureOrg({ slug: `fresh-${crypto.randomUUID().slice(0, 8)}`, name: "Fresh" }))
    .orgId
  // Its first person, as the provisioning that follows makes one.
  const first = crypto.randomUUID()
  await withPrivilegedDb(orgId, "test-first-admin", async (tx) => {
    const K = schemaRef("kernel")
    const [role] = extractRows<{ id: string }>(
      await tx.execute(sql`
        SELECT id::text AS id FROM ${sql.raw(K)}.roles
         WHERE org_id = ${orgId}::uuid AND name = 'admin'`),
    )
    await tx.execute(
      sql.raw(
        insertSql(`${K}.users`, {
          id: first,
          org_id: orgId,
          email: `first-${first}@example.test`,
          name: "First",
          status: "active",
          auth_version: 1,
          permission_version: 1,
        }),
      ),
    )
    await tx.execute(
      sql.raw(
        insertSql(`${K}.user_roles`, { org_id: orgId, user_id: first, role_id: role?.id ?? "" }),
      ),
    )
  })
  admin = await minimal.sessionOf(await minimal.orgAdmin(orgId))
  const p = await minimal.person(orgId, { name: "New member" })
  await minimal.assignRole(p.id, "Full Member")
  member = await minimal.sessionOf(p)
  const ctx = await held(member.userId)
  shelf = await withRlsContext(ctx, async (tx) => {
    const actor = knowledgeActorFromContext(ctx as never)
    return (await createKnowledgeCollection(tx, { name: "Shelf", ownerUserId: null }, actor)).id
  })
})
afterAll(releaseTestLock)

async function held(userId: string): Promise<UserContext> {
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
  } as UserContext
}

async function create(input: Record<string, unknown>): Promise<{ status: number; id?: string }> {
  const res = await app.request("/api/knowledge/documents", {
    method: "POST",
    headers: { Authorization: `Bearer ${member.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Page", body: "body", documentScope: "organization", ...input }),
  })
  const body = (await res.json()) as { data?: { id: string } }
  return { status: res.status, ...(body.data ? { id: body.data.id } : {}) }
}

async function stored(id: string | undefined) {
  const [row] = extractRows<{ sensitivity: string; org_access: string; folders: string[] }>(
    await withPrivilegedDb(orgId, "test-stored", (tx) =>
      tx.execute(sql`
        SELECT d.sensitivity, d.org_access,
               ARRAY(SELECT m.collection_id::text FROM ${knowledgeRel("collection_memberships")} m
                      WHERE m.target_id = d.id) AS folders
          FROM ${knowledgeRel("documents")} d WHERE d.id = ${id ?? ""}::uuid`),
    ),
  )
  return row
}

async function agent(params: Record<string, unknown>) {
  const res = await executeTool<{ status?: string; approval_id?: string; id?: string }>({
    toolName: "knowledge:create",
    orgId,
    actor: await held(member.userId),
    params: { body: "body", documentScope: "organization", ...params },
    threadId: await minimal.thread(orgId, member.userId, { title: String(params.title) }),
    origin: "in-app-agent",
    stepBundleId: null,
  } as never)
  return res.data as { status?: string; approval_id?: string; error?: unknown }
}

async function titled(title: string) {
  const [row] = extractRows<{ id: string }>(
    await withPrivilegedDb(orgId, "test-titled", (tx) =>
      tx.execute(sql`
        SELECT id::text AS id FROM ${knowledgeRel("documents")}
         WHERE org_id = ${orgId}::uuid AND title = ${title}`),
    ),
  )
  return row?.id
}

describe("a Full Member of a new organization", () => {
  it("holds no dimension grant at all", async () => {
    expect((await held(member.userId)).dimensionGrants).toEqual({})
  })

  it("creates a shared page, an Only me page, a public one and one in a folder", async () => {
    for (const [input, want] of [
      [{}, { sensitivity: "internal", org_access: "editor", folders: [] }],
      [{ orgAccess: "none" }, { sensitivity: "internal", org_access: "none", folders: [] }],
      [{ sensitivity: "public" }, { sensitivity: "public", org_access: "editor", folders: [] }],
      [
        { collectionIds: [shelf], orgAccess: "viewer" },
        { sensitivity: "internal", org_access: "viewer", folders: [shelf] },
      ],
    ] as const) {
      const made = await create(input)
      expect({ input, status: made.status }).toEqual({ input, status: 201 })
      expect(await stored(made.id)).toEqual(want as never)
    }
    expect((await create({ documentScope: "personal" })).status).toBe(201)
  })

  it("still needs the grant for a confidential or a restricted page, and for a team", async () => {
    for (const input of [
      { sensitivity: "confidential" },
      { sensitivity: "restricted" },
      { sensitivity: "confidential", orgAccess: "none" },
      { team: ["finance"] },
    ]) {
      expect({ input, status: (await create(input)).status }).toEqual({ input, status: 403 })
    }
  })

  it("row security says the same, without the service", async () => {
    const ctx = await held(member.userId)
    const insert = (over: Record<string, RowValue>) =>
      withRlsContext(ctx, (tx) =>
        tx.execute(
          sql.raw(
            insertSql(`${schemaRef("app_knowledge")}.documents`, {
              org_id: orgId,
              title: "raw",
              body: "b",
              document_scope: "organization",
              owner_user_id: member.userId,
              created_by: member.userId,
              team: { raw: "'[]'::jsonb" },
              required_scopes: { raw: "'{}'::text[]" },
              ...over,
            }),
          ),
        ),
      ).then(
        () => "accepted",
        (err: Error) => `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`,
      )
    expect(await insert({ sensitivity: "internal" })).toBe("accepted")
    expect(await insert({ sensitivity: "public" })).toBe("accepted")
    const refused: Record<string, RowValue>[] = [
      { sensitivity: "confidential" },
      { sensitivity: "restricted" },
      { sensitivity: "internal", team: { raw: `'["finance"]'::jsonb` } },
    ]
    for (const over of refused) {
      expect(await insert(over)).toMatch(/row-level security/)
    }
  })

  it("their agent's internal page is written once its card is approved", async () => {
    const title = "Written by my agent"
    const out = await agent({ title, sensitivity: "internal", collectionId: shelf })
    expect(out.status).toBe("pending_approval")
    await decideApproval({
      orgId,
      actor: (await held(admin.userId)) as never,
      requestId: String(out.approval_id),
      decision: "approve",
    })
    expect(await stored(await titled(title))).toEqual({
      sensitivity: "internal",
      org_access: "editor",
      folders: [shelf],
    })
  })

  it("changes no label they may not set: re-labelling keeps the whole check", async () => {
    const made = await create({ title: "Label" })
    const res = await app.request(`/api/knowledge/documents/${made.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${member.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, sensitivity: "public" }),
    })
    expect(res.status).not.toBe(200)
    expect((await stored(made.id))?.sensitivity).toBe("internal")
  })
})
