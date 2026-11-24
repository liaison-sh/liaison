// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a member may do with folders and pages: folders like anyone, pages they
 * may edit, one request to move a page, a refusal that says so. Over HTTP, with
 * the scopes the real role carries.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { app } from "~/app"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { initializedOrgRuntimes, resetAppRegistries } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let ana: minimal.Session
let ben: minimal.Session

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  const member = async (name: string) => {
    const p = await minimal.person(orgId, { name })
    await minimal.assignRole(p.id, "Full Member")
    await classify(p.id)
    return minimal.sessionOf(p)
  }
  ana = await member("Ana")
  ben = await member("Ben")
})
afterAll(releaseTestLock)

/** The right to write pages of the default sensitivity, which an admin gives apart from roles. */
async function classify(userId: string): Promise<void> {
  await withPrivilegedDb(orgId, "test-sensitivity", (tx) =>
    tx.execute(
      sql.raw(
        insertSql(`${schemaRef("kernel")}.user_dimension_grants`, {
          user_id: userId,
          org_id: orgId,
          dimension_key: "knowledge:sensitivity",
          dimension_values: { raw: `'["internal"]'::jsonb` },
        }),
      ),
    ),
  )
}

interface Answer {
  status: number
  data: Record<string, unknown> & { id: string }
  error?: { message: string; code?: string }
}

async function http(
  s: minimal.Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const res = await app.request(`/api/knowledge${path}`, {
    method,
    headers: { Authorization: `Bearer ${s.bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, ...((await res.json()) as object) } as Answer
}

async function folder(s: minimal.Session, name: string, extra: object = {}): Promise<string> {
  const made = await http(s, "POST", "/collections", { name, ownerUserId: null, ...extra })
  expect({ name, status: made.status, error: made.error }).toEqual({
    name,
    status: 201,
    error: undefined,
  })
  return made.data.id
}

async function page(s: minimal.Session, title: string, extra: object = {}): Promise<string> {
  const made = await http(s, "POST", "/documents", {
    title,
    body: "body",
    documentScope: "organization",
    ...extra,
  })
  expect({ title, status: made.status, error: made.error }).toEqual({
    title,
    status: 201,
    error: undefined,
  })
  return made.data.id
}

async function memberships(target: string): Promise<string[]> {
  return extractRows<{ row: string }>(
    await withSystemDb("test-memberships", (tx) =>
      tx.execute(sql`
        SELECT id::text || ' ' || collection_id::text AS row
          FROM ${knowledgeRel("collection_memberships")}
         WHERE target_id = ${target}::uuid ORDER BY 1`),
    ),
  ).map((r) => r.row)
}

const foldersOf = async (target: string) =>
  (await memberships(target)).map((m) => m.split(" ")[1]).sort()

async function tool(
  s: minimal.Session,
  scopes: string[],
  method: string,
  params: Record<string, unknown>,
): Promise<string> {
  const ctx = { orgId, userId: s.userId, scopes, dimensionGrants: { "*": ["*"] } }
  return withRlsContext({ actorType: "user" as const, ...ctx }, async (tx) => {
    const bridge = createRpcBridge(
      "knowledge",
      s.userId,
      orgId,
      tx,
      { name: "knowledge", events: { emits: [] } },
      scopes,
      "user",
    )
    return (bridge[method] as (p: string) => Promise<string>)(JSON.stringify(params))
  }).catch((err: Error) => `refused: ${err.message}`)
}

const MEMBER_SCOPES = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
  "knowledge:collections:manage",
]

describe("a member manages folders", () => {
  it("creates, renames, moves and deletes them, over HTTP, with no extra role", async () => {
    const top = await folder(ana, "Member folder")
    const other = await folder(ana, "Member other folder")
    expect((await http(ben, "PATCH", `/collections/${top}`, { name: "Renamed" })).status).toBe(200)
    expect(
      (await http(ben, "PATCH", `/collections/${top}`, { parentCollectionId: other })).status,
    ).toBe(200)
    expect((await http(ben, "POST", `/collections/${top}/archive`, {})).status).toBe(200)
  })

  it("someone without the scope is told so: 403 on every folder route", async () => {
    const top = await folder(ana, "No scope")
    const doc = await page(ana, "No scope page", { collectionIds: [top] })
    const outsider = await minimal.person(orgId, { name: "Reader" })
    for (const scope of ["knowledge:documents:read", "knowledge:documents:create"]) {
      await minimal.grantScope(outsider.id, scope)
    }
    const s = await minimal.sessionOf(outsider)
    const member = { targetType: "document", targetId: doc }
    for (const [method, path, body] of [
      ["POST", "/collections", { name: "x" }],
      ["PATCH", `/collections/${top}`, { name: "x" }],
      ["POST", `/collections/${top}/archive`, {}],
      ["POST", `/collections/${top}/members`, member],
      ["DELETE", `/collections/${top}/members`, member],
      [
        "POST",
        "/documents",
        { title: "x", body: "", documentScope: "organization", collectionIds: [top] },
      ],
      ["POST", `/documents/${doc}/move`, { fromCollectionId: top, toCollectionId: null }],
    ] as const) {
      const res = await http(s, method, path, body)
      expect({ method, path, status: res.status, message: res.error?.message }).toEqual({
        method,
        path,
        status: 403,
        message: "Forbidden: you cannot manage Knowledge folders",
      })
    }
    expect(await foldersOf(doc)).toEqual([top])
  })
})

describe("moving a page", () => {
  it("leaves its source folder and enters its target in one request, with one event", async () => {
    const from = await folder(ana, "From")
    const to = await folder(ana, "To")
    const doc = await page(ana, "Moving", { collectionIds: [from] })
    const before = await events()
    const res = await http(ana, "POST", `/documents/${doc}/move`, {
      fromCollectionId: from,
      toCollectionId: to,
    })
    expect({ status: res.status, error: res.error }).toEqual({ status: 200, error: undefined })
    expect(await foldersOf(doc)).toEqual([to])
    expect((await events()) - before).toBe(1)
  })

  async function events(): Promise<number> {
    const [row] = extractRows<{ n: number }>(
      await withSystemDb("test-membership-events", (tx) =>
        tx.execute(sql`
          SELECT count(*)::int AS n FROM kernel.pending_events
           WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'collection_membership'`),
      ),
    )
    return row?.n ?? 0
  }

  it("failed target leaves the page in its source folder", async () => {
    const from = await folder(ana, "Stays")
    const doc = await page(ana, "Not moving", { collectionIds: [from] })
    const bens = await folder(ben, "Ben's own", { ownerUserId: ben.userId })
    for (const to of [bens, crypto.randomUUID()]) {
      const before = await memberships(doc)
      const res = await http(ana, "POST", `/documents/${doc}/move`, {
        fromCollectionId: from,
        toCollectionId: to,
      })
      expect({ status: res.status, message: res.error?.message }).toEqual({
        status: 404,
        message: "You cannot do this on this page",
      })
      expect(await memberships(doc)).toEqual(before)
    }
  })

  it("a page that has left the source folder meanwhile is not filed twice", async () => {
    const from = await folder(ana, "Left")
    const to = await folder(ana, "Never reached")
    const doc = await page(ana, "Elsewhere already")
    const res = await http(ana, "POST", `/documents/${doc}/move`, {
      fromCollectionId: from,
      toCollectionId: to,
    })
    expect(res.status).toBe(400)
    expect(res.error?.message).toMatch(/no longer in that folder/)
    expect(await foldersOf(doc)).toEqual([])
  })

  it("into a folder and out to no folder both work", async () => {
    const to = await folder(ana, "In then out")
    const doc = await page(ana, "In and out")
    expect(
      (
        await http(ana, "POST", `/documents/${doc}/move`, {
          fromCollectionId: null,
          toCollectionId: to,
        })
      ).status,
    ).toBe(200)
    expect(await foldersOf(doc)).toEqual([to])
    expect(
      (
        await http(ana, "POST", `/documents/${doc}/move`, {
          fromCollectionId: to,
          toCollectionId: null,
        })
      ).status,
    ).toBe(200)
    expect(await foldersOf(doc)).toEqual([])
  })

  it("viewer gets 404, nothing moved, the same answer as for a page that does not exist", async () => {
    const from = await folder(ana, "Viewed")
    const to = await folder(ana, "Viewed target")
    const doc = await page(ana, "View only", { collectionIds: [from], orgAccess: "viewer" })
    const before = await memberships(doc)
    const move = (id: string) =>
      http(ben, "POST", `/documents/${id}/move`, { fromCollectionId: from, toCollectionId: to })
    const refused = await move(doc)
    expect(refused).toEqual(await move(crypto.randomUUID()))
    expect({ status: refused.status, error: refused.error }).toEqual({
      status: 404,
      error: { message: "You cannot do this on this page", code: "NOT_FOUND" },
    })
    expect(await memberships(doc)).toEqual(before)
  })

  it("a refused write on a page says so, in the zero-knowledge shape", async () => {
    const doc = await page(ana, "Renamed by nobody", { orgAccess: "viewer" })
    const res = await http(ben, "PATCH", `/documents/${doc}`, { title: "x", revision: 1 })
    expect({ status: res.status, error: res.error }).toEqual({
      status: 404,
      error: { message: "You cannot do this on this page", code: "NOT_FOUND" },
    })
  })
})

describe("filing at create", () => {
  it("filing at create in a folder I cannot see is refused", async () => {
    const bens = await folder(ben, "Ben's private shelf", { ownerUserId: ben.userId })
    const gone = await folder(ana, "Deleted shelf")
    await http(ana, "POST", `/collections/${gone}/archive`, {})
    for (const id of [bens, gone, crypto.randomUUID()]) {
      const res = await http(ana, "POST", "/documents", {
        title: "Filed where it cannot be",
        body: "",
        documentScope: "organization",
        collectionIds: [id],
      })
      expect({ status: res.status, code: res.error?.code }).toEqual({
        status: 404,
        code: "NOT_FOUND",
      })
    }
    const [row] = extractRows<{ n: number }>(
      await withSystemDb("test-no-page", (tx) =>
        tx.execute(sql`
          SELECT count(*)::int AS n FROM ${knowledgeRel("documents")}
           WHERE org_id = ${orgId}::uuid AND title = 'Filed where it cannot be'`),
      ),
    )
    expect(row?.n).toBe(0)
  })
})

describe("taking a page out of a folder", () => {
  it("viewer: POST and DELETE member routes and both agent tools, remove refused on each, membership rows identical before and after", async () => {
    const top = await folder(ana, "Curated")
    const second = await folder(ana, "Curated too")
    const doc = await page(ana, "Curated page", {
      collectionIds: [top, second],
      orgAccess: "viewer",
    })
    const link = await sourceLink(top)
    const before = [await memberships(doc), await memberships(link)]

    const removed = await http(ben, "DELETE", `/collections/${top}/members`, {
      targetType: "document",
      targetId: doc,
    })
    expect({ status: removed.status, error: removed.error }).toEqual({
      status: 404,
      error: { message: "You cannot do this on this page", code: "NOT_FOUND" },
    })
    expect(
      await tool(ben, MEMBER_SCOPES, "knowledge_remove_from_collection", {
        collectionId: top,
        documentId: doc,
      }),
    ).toMatch(/^refused: Forbidden to write/)
    // Out of its last folder is the same check.
    const linkScopes = MEMBER_SCOPES.filter((s) => s !== "knowledge:documents:update")
    expect(
      await asActor(ben, linkScopes, async (tx, a) => {
        const { removeCollectionMembership } = await import("~/apps/knowledge/collections")
        await removeCollectionMembership(
          tx,
          { collectionId: top, targetType: "source_link", targetId: link },
          a,
        )
      }),
    ).toMatch(/Forbidden/)
    expect([await memberships(doc), await memberships(link)]).toEqual(before)

    // Filing adds a place, removes none and gives nobody access: reading is enough.
    const third = await folder(ben, "Ben's reading list")
    expect(
      (
        await http(ben, "POST", `/collections/${third}/members`, {
          targetType: "document",
          targetId: doc,
        })
      ).status,
    ).toBe(201)
    const fourth = await folder(ben, "Ben's agent list")
    expect(
      await tool(ben, MEMBER_SCOPES, "knowledge_add_to_collection", {
        collectionId: fourth,
        documentId: doc,
      }),
    ).not.toMatch(/^refused/)
    expect(await foldersOf(doc)).toEqual([top, second, third, fourth].sort())

    // Its editor takes it out.
    expect(
      (
        await http(ana, "DELETE", `/collections/${third}/members`, {
          targetType: "document",
          targetId: doc,
        })
      ).status,
    ).toBe(200)
  })

  async function asActor(
    s: minimal.Session,
    scopes: string[],
    fn: (tx: RlsClient, a: KnowledgeActor) => Promise<void>,
  ): Promise<string> {
    const ctx = { orgId, userId: s.userId, scopes, dimensionGrants: { "*": ["*"] } }
    try {
      await withRlsContext({ actorType: "user" as const, ...ctx }, (tx) =>
        fn(tx, knowledgeActorFromContext(ctx)),
      )
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    return "accepted"
  }

  /** A source link filed in the folder, as the sync of a shared folder leaves one. */
  async function sourceLink(collectionId: string): Promise<string> {
    const identity = crypto.randomUUID()
    const id = crypto.randomUUID()
    await withPrivilegedDb(orgId, "test-source-link", async (tx) => {
      for (const [table, row] of [
        [
          "source_identities",
          { id: identity, org_id: orgId, source: "google-drive", external_id: identity },
        ],
        [
          "source_links",
          {
            id,
            org_id: orgId,
            source_identity_id: identity,
            source: "google-drive",
            external_id: identity,
            title: "Linked",
            owner_user_id: ana.userId,
          },
        ],
        [
          "collection_memberships",
          { org_id: orgId, collection_id: collectionId, target_type: "source_link", target_id: id },
        ],
      ] as const) {
        await tx.execute(sql.raw(insertSql(`${schemaRef("app_knowledge")}.${table}`, { ...row })))
      }
    })
    return id
  }
})

describe("lists that showed less than there was", () => {
  it("needs review lists the 51st oldest page", async () => {
    const oldest = await page(ana, "Oldest to review")
    await withPrivilegedDb(orgId, "test-needs-review", (tx) =>
      tx.execute(sql`
        UPDATE ${knowledgeRel("documents")}
           SET review_status = 'needs_review', updated_at = now() - interval '400 days'
         WHERE id = ${oldest}::uuid`),
    )
    for (let i = 0; i < 51; i++) await page(ana, `Newer ${i}`)
    const home = await http(ana, "GET", "/home")
    const listed = home.data.needsReview as Array<{ id: string }>
    expect(listed.map((d) => d.id)).toContain(oldest)
  })
})

// Last: it bumps every member's permission version.
describe("an older organization", () => {
  it("an organization registered before gets the scope when its apps register again", async () => {
    const scopes = async () =>
      extractRows<{ name: string }>(
        await withSystemDb("test-role-scopes", (tx) =>
          tx.execute(sql`
            SELECT r.name FROM kernel.role_scope_grants g JOIN kernel.roles r ON r.id = g.role_id
             WHERE r.org_id = ${orgId}::uuid AND g.scope = 'knowledge:collections:manage'
               AND r.name IN ('Full Member', 'knowledge.member') ORDER BY 1`),
        ),
      ).map((r) => r.name)
    await withPrivilegedDb(orgId, "test-forget-scope", (tx) =>
      tx.execute(sql`
        DELETE FROM kernel.role_scope_grants g USING kernel.roles r
         WHERE r.id = g.role_id AND r.org_id = ${orgId}::uuid
           AND g.scope = 'knowledge:collections:manage'
           AND r.name IN ('Full Member', 'knowledge.member')`),
    )
    // The row a release whose member role lacked the scope leaves behind.
    await withPrivilegedDb(orgId, "test-older-release", (tx) =>
      tx.execute(sql`
        UPDATE kernel.apps SET version = '1.0.9'
         WHERE org_id = ${orgId}::uuid AND name = 'knowledge'`),
    )
    expect(await scopes()).toEqual([])
    // A new process: nothing registered in memory.
    resetAppRegistries()
    initializedOrgRuntimes.clear()
    await ensureAppsForOrg(orgId)
    expect(await scopes()).toEqual(["Full Member", "knowledge.member"])
  })
})
