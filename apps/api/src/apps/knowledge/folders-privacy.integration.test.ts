// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A personal folder is its owner's alone, through every way in, admins included,
 * and no page ever ends in no place: what a reader sees in no folder of theirs is
 * in their Unfiled. Real database, row security on.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import {
  addCollectionMembership,
  archiveKnowledgeCollection,
  type CollectionTreeNode,
  createKnowledgeCollection,
  type KnowledgeCollectionInput,
  listKnowledgeCollections,
  listKnowledgeCollectionTree,
  loadCollection,
  removeCollectionMembership,
  updateKnowledgeCollection,
} from "~/apps/knowledge/collections"
import { runSyncWorker } from "~/apps/knowledge/knowledge-jobs"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  createKnowledgeDocument,
  type KnowledgeActor,
  knowledgeActorFromContext,
  listKnowledgeDocuments,
} from "~/apps/knowledge/service"
import { upsertSyncedCollection } from "~/apps/knowledge/sync-reconciler"
import {
  createSyncedSource,
  reactivateSyncedSource,
  type SyncedSourceRow,
} from "~/apps/knowledge/synced-sources"
import { knowledgeProvisioner } from "~/cli/provisioners/knowledge"
import { buildProvisionContext } from "~/cli/provisioners/types"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { eraseUser } from "~/modules/erasure/erase-user"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MEMBER = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
  "knowledge:collections:manage",
]
const ADMIN = ["*"]
const GRANTS = { "*": ["*"] }

let orgId: string
let ana: string
let ben: string
let admin: string

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  admin = (await minimal.orgAdmin(orgId)).id
  ana = (await minimal.person(orgId, { name: "Ana" })).id
  ben = (await minimal.person(orgId, { name: "Ben" })).id
})
afterAll(releaseTestLock)

type Run<T> = (tx: RlsClient, actor: KnowledgeActor) => Promise<T>

function as<T>(userId: string, fn: Run<T>, scopes: string[] = MEMBER): Promise<T> {
  const ctx = { orgId, userId, scopes, dimensionGrants: GRANTS }
  return withRlsContext({ actorType: "user" as const, ...ctx }, (tx) =>
    fn(tx, knowledgeActorFromContext(ctx)),
  )
}

const folder = (userId: string, input: KnowledgeCollectionInput) =>
  as(userId, (tx, a) => createKnowledgeCollection(tx, input, a))
const shared = (userId: string, name: string, parentCollectionId?: string) =>
  folder(userId, { name, ownerUserId: null, ...(parentCollectionId ? { parentCollectionId } : {}) })
const personal = (userId: string, name: string, parentCollectionId?: string) =>
  folder(userId, {
    name,
    ownerUserId: userId,
    ...(parentCollectionId ? { parentCollectionId } : {}),
  })

async function page(
  userId: string,
  title: string,
  opts: { in?: string; access?: "none" | "viewer" | "editor" } = {},
): Promise<string> {
  const doc = await as(userId, (tx, a) =>
    createKnowledgeDocument(
      tx,
      {
        documentScope: "organization",
        title,
        body: "body",
        collectionIds: opts.in ? [opts.in] : [],
        tagNames: [],
        team: [],
        sensitivity: "internal",
        orgAccess: opts.access ?? "editor",
        verifyNow: false,
      },
      a,
      [],
    ),
  )
  return doc.id
}

const tree = (userId: string, scopes?: string[]) =>
  as(userId, (tx, a) => listKnowledgeCollectionTree(tx, a), scopes)

function nodes(list: CollectionTreeNode[]): CollectionTreeNode[] {
  return list.flatMap((n) => [n, ...nodes(n.children)])
}

async function node(userId: string, id: string): Promise<CollectionTreeNode | undefined> {
  return nodes(await tree(userId)).find((n) => n.id === id)
}

const has = (n: CollectionTreeNode | undefined, docId: string) =>
  (n?.documents ?? []).some((d) => d.id === docId)

async function inUnfiled(userId: string, docId: string): Promise<{ tree: boolean; list: boolean }> {
  const list = await as(userId, (tx, a) =>
    listKnowledgeDocuments(tx, a, { unfiled: true, limit: 200 }),
  )
  return {
    tree: has(await node(userId, "__unfiled__"), docId),
    list: list.some((d) => d.id === docId),
  }
}

async function folderRow(id: string) {
  const [row] = extractRows<{
    name: string
    owner_user_id: string | null
    parent_collection_id: string | null
    archived: boolean
  }>(
    await withSystemDb("test-folder-row", (tx) =>
      tx.execute(sql`
        SELECT name, owner_user_id::text AS owner_user_id,
               parent_collection_id::text AS parent_collection_id,
               archived_at IS NOT NULL AS archived
          FROM ${knowledgeRel("collections")} WHERE id = ${id}::uuid`),
    ),
  )
  return row
}

async function privileged(statement: ReturnType<typeof sql>): Promise<void> {
  await withPrivilegedDb(orgId, "test-folders-privacy", (tx) => tx.execute(statement))
}

async function tool(
  userId: string,
  method: string,
  params: Record<string, unknown>,
  scopes: string[] = MEMBER,
): Promise<string> {
  return as(
    userId,
    async (tx) => {
      const bridge = createRpcBridge(
        "knowledge",
        userId,
        orgId,
        tx,
        { name: "knowledge", events: { emits: [] } },
        scopes,
        "user",
      )
      return (bridge[method] as (p: string) => Promise<string>)(JSON.stringify(params))
    },
    scopes,
  )
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return "accepted"
}

describe("a personal folder", () => {
  it("B never sees A's personal folder in list, tree, collection detail, memberships, agent bridge, admin included", async () => {
    const mine = await personal(ana, "Ana notes on salaries")
    const under = await personal(ana, "Ana 2027 plan", mine.id)
    const doc = await page(ana, "A page Ana shares", { in: mine.id })
    const theirs = await shared(ben, "Ben's shared folder")

    const own = JSON.stringify(await tree(ana))
    expect(own).toContain(mine.id)
    expect(own).toContain(under.id)

    for (const [reader, scopes] of [
      [ben, MEMBER],
      [admin, ADMIN],
    ] as const) {
      const listed = await as(reader, (tx, a) => listKnowledgeCollections(tx, a), [...scopes])
      const seen = JSON.stringify([listed, await tree(reader, [...scopes])])
      for (const secret of [mine.id, under.id, "Ana notes", "Ana 2027"]) {
        expect(seen).not.toContain(secret)
      }
      for (const id of [mine.id, under.id]) {
        expect(await as(reader, (tx, a) => loadCollection(tx, id, a), [...scopes])).toBeNull()
      }
      const raw = await as(
        reader,
        async (tx) => ({
          folders: extractRows(
            await tx.execute(sql`
              SELECT id FROM ${knowledgeRel("collections")}
              WHERE id IN (${mine.id}::uuid, ${under.id}::uuid)`),
          ),
          memberships: extractRows(
            await tx.execute(sql`
              SELECT id FROM ${knowledgeRel("collection_memberships")}
              WHERE collection_id = ${mine.id}::uuid OR (target_id = ${doc}::uuid)`),
          ),
        }),
        [...scopes],
      )
      expect(raw).toEqual({ folders: [], memberships: [] })

      const attempts = {
        rename: () =>
          tool(reader, "knowledge_collection_update", { id: mine.id, name: "x" }, [...scopes]),
        remove: () => tool(reader, "knowledge_collection_delete", { id: mine.id }, [...scopes]),
        file: () =>
          tool(reader, "knowledge_add_to_collection", { collectionId: mine.id, documentId: doc }, [
            ...scopes,
          ]),
        unfile: () =>
          tool(
            reader,
            "knowledge_remove_from_collection",
            { collectionId: mine.id, documentId: doc },
            [...scopes],
          ),
        nest: () =>
          tool(reader, "knowledge_collection_create", { name: "x", parentCollectionId: mine.id }, [
            ...scopes,
          ]),
        moveInto: () =>
          tool(
            reader,
            "knowledge_collection_update",
            { id: theirs.id, parentCollectionId: mine.id },
            [...scopes],
          ),
        create: () =>
          tool(
            reader,
            "knowledge_create",
            { title: "x", body: "x", documentScope: "organization", collectionId: mine.id },
            [...scopes],
          ),
      }
      for (const [what, attempt] of Object.entries(attempts)) {
        const answer = await refusal(
          attempt().then((out) => {
            // A refusal the bridge answers in band names no folder either.
            expect(out).not.toContain("Ana notes")
            if (/collection_not_found/.test(out)) throw new Error("not found")
          }),
        )
        expect({ what, refused: /not found/i.test(answer) }).toEqual({ what, refused: true })
        expect(answer).not.toContain("Ana")
      }
    }
    expect(await folderRow(mine.id)).toEqual({
      name: "Ana notes on salaries",
      owner_user_id: ana,
      parent_collection_id: null,
      archived: false,
    })
  })

  it("nobody can write a folder of somebody else, by SQL under row security either", async () => {
    const mine = await personal(ana, "Ana drafts")
    const changed = await as(ben, (tx) =>
      tx.execute(sql`
        UPDATE ${knowledgeRel("collections")} SET name = 'taken' WHERE id = ${mine.id}::uuid
        RETURNING id`),
    )
    expect(extractRows(changed)).toHaveLength(0)
    expect(
      await refusal(
        as(ben, (tx) =>
          tx.execute(sql`
            UPDATE ${knowledgeRel("collections")} SET owner_user_id = ${ana}::uuid
            WHERE id = (SELECT id FROM ${knowledgeRel("collections")}
                        WHERE owner_user_id IS NULL LIMIT 1)`),
        ),
      ),
    ).not.toBe("accepted")
    expect(await refusal(folder(ben, { name: "For Ana", ownerUserId: ana }))).toMatch(
      /only be your own/,
    )
  })

  it("the statements of the previous release still run on this schema", async () => {
    const id = randomUUID()
    const docId = await page(ana, "Old release page")
    await as(ana, async (tx) => {
      const insert = (table: string, row: Record<string, RowValue>) =>
        tx.execute(
          sql.raw(
            insertSql(`${schemaRef("app_knowledge")}.${table}`, row, { onConflictDoNothing: true }),
          ),
        )
      await insert("collections", {
        id,
        org_id: orgId,
        name: "Old release",
        description: null,
        parent_collection_id: null,
        owner_user_id: ana,
        maintainer_user_ids: { raw: "'[]'::jsonb" },
      })
      await insert("collection_memberships", {
        org_id: orgId,
        collection_id: id,
        target_type: "document",
        target_id: docId,
        created_by: ana,
      })
      await tx.execute(sql`
        UPDATE ${knowledgeRel("collections")} SET owner_user_id = NULL, updated_at = now()
        WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`)
    })
    // It archives without emptying: the page comes back in Unfiled.
    expect(has(await node(ben, id), docId)).toBe(true)
    await as(ana, (tx) =>
      tx.execute(sql`
        UPDATE ${knowledgeRel("collections")} SET archived_at = now(), updated_at = now()
        WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`),
    )
    expect(await inUnfiled(ben, docId)).toEqual({ tree: true, list: true })
  })

  it("a subfolder belongs to whoever owns its parent", async () => {
    const top = await personal(ana, "Ana top")
    const child = await folder(ana, {
      name: "Ana child",
      parentCollectionId: top.id,
      ownerUserId: null,
    })
    expect(child.ownerUserId).toBe(ana)
    const team = await shared(ana, "Team top")
    const teamChild = await folder(ana, { name: "Team child", parentCollectionId: team.id })
    expect(teamChild.ownerUserId).toBeNull()
  })
})

describe("no page ends in no place", () => {
  it("page shared by A inside A's personal folder is in B's Unfiled", async () => {
    const mine = await personal(ana, "Ana shelf")
    const doc = await page(ana, "Shared from a personal folder", { in: mine.id })
    expect(await inUnfiled(ben, doc)).toEqual({ tree: true, list: true })
    expect(await inUnfiled(ana, doc)).toEqual({ tree: false, list: false })
    expect(has(await node(ana, mine.id), doc)).toBe(true)
  })

  it("a private page of mine in no folder is in my personal notes, in nobody's Unfiled", async () => {
    const doc = await page(ana, "Only mine", { access: "none" })
    expect(has(await node(ana, "__personal_notes__"), doc)).toBe(true)
    expect(await inUnfiled(ana, doc)).toEqual({ tree: false, list: false })
    expect(JSON.stringify(await tree(ben))).not.toContain(doc)
  })

  it("delete folder with a page the deleter cannot read: its owner finds it in the parent", async () => {
    const parent = await shared(ana, "Parent")
    const child = await shared(ana, "Child", parent.id)
    const grandchild = await shared(ana, "Grandchild", child.id)
    const hidden = await page(ben, "Ben's private page", { in: child.id, access: "none" })
    const open = await page(ana, "Open page", { in: child.id })
    const already = await page(ana, "Filed in both", { in: child.id })
    await as(ana, (tx, a) =>
      addCollectionMembership(
        tx,
        { collectionId: parent.id, targetType: "document", targetId: already },
        a,
      ),
    )

    await as(ana, (tx, a) => archiveKnowledgeCollection(tx, child.id, a))

    const seenByBen = await node(ben, parent.id)
    expect(has(seenByBen, hidden)).toBe(true)
    expect(has(seenByBen, open)).toBe(true)
    expect(seenByBen?.documents.filter((d) => d.id === already)).toHaveLength(1)
    expect(has(await node(ana, parent.id), hidden)).toBe(false)
    expect((await folderRow(grandchild.id))?.parent_collection_id).toBe(parent.id)
    expect((await folderRow(child.id))?.archived).toBe(true)
  })

  it("delete at root: its pages are unfiled, its subfolders at the top", async () => {
    const top = await shared(ana, "Top to delete")
    const sub = await shared(ana, "Sub of top", top.id)
    const doc = await page(ben, "Page of a deleted top", { in: top.id })
    await as(ana, (tx, a) => archiveKnowledgeCollection(tx, top.id, a))
    expect(await inUnfiled(ben, doc)).toEqual({ tree: true, list: true })
    expect((await folderRow(sub.id))?.parent_collection_id).toBeNull()
    expect((await folderRow(sub.id))?.archived).toBe(false)
  })

  it("a page whose only folder was archived before is in Unfiled", async () => {
    const old = await shared(ana, "Archived long ago")
    const doc = await page(ana, "Hidden since then", { in: old.id })
    await privileged(
      sql`UPDATE ${knowledgeRel("collections")} SET archived_at = now() WHERE id = ${old.id}::uuid`,
    )
    expect(await inUnfiled(ben, doc)).toEqual({ tree: true, list: true })
  })

  it("the tree names its virtual nodes by kind and lists pages by title", async () => {
    const top = await shared(ana, "Sorted")
    for (const title of ["beta", "Alpha", "gamma"]) await page(ana, title, { in: top.id })
    const list = await tree(ana)
    expect(list.find((n) => n.id === "__unfiled__")?.kind).toBe("unfiled")
    expect(list.find((n) => n.id === "__personal_notes__")?.kind).toBe("personal_notes")
    const sorted = list.find((n) => n.id === top.id)
    expect(sorted?.kind).toBe("folder")
    expect(sorted?.documents.map((d) => d.title)).toEqual(["Alpha", "beta", "gamma"])
  })
})

describe("who a new folder is for", () => {
  it("an agent's folder is shared unless it asks for a personal one", async () => {
    const made = JSON.parse(await tool(ana, "knowledge_collection_create", { name: "Agent made" }))
    expect(made.ownerUserId).toBeNull()
    expect(await node(ben, made.id)).toBeDefined()
    const own = JSON.parse(
      await tool(ana, "knowledge_collection_create", { name: "Agent made mine", personal: true }),
    )
    expect(own.ownerUserId).toBe(ana)
  })

  async function apply(name: string, document?: string) {
    const dir = mkdtempSync(join(tmpdir(), "kb-folders-"))
    try {
      const ctx = buildProvisionContext({ log: () => {}, validateByok: false, configDir: dir })
      ctx.orgId = orgId
      ctx.actor.userId = admin
      ctx.actor.scopes = ["*"]
      await knowledgeProvisioner.apply(ctx, { actions: [] }, {
        org: { slug: "x", name: "X" },
        knowledge: {
          collections: [{ name }],
          ...(document
            ? { documents: [{ title: document, collection: name, content: "text" }] }
            : {}),
        },
      } as never)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("provisioned folder is visible to a second member", async () => {
    await apply("Provisioned handbook")
    const listed = await as(ben, (tx, a) => listKnowledgeCollections(tx, a))
    expect(listed.filter((c) => c.name === "Provisioned handbook")).toHaveLength(1)
  })

  it("personal folder named Policies: apply still creates the shared one and files into it", async () => {
    const own = await personal(admin, "Policies")
    const bens = await personal(ben, "Policies")
    await apply("Policies", "Provisioned policy")
    const listed = await as(ben, (tx, a) => listKnowledgeCollections(tx, a))
    const sharedOne = listed.find((c) => c.name === "Policies" && c.ownerUserId === null)
    expect(sharedOne).toBeDefined()
    expect((await node(ben, sharedOne?.id ?? ""))?.documents.map((d) => d.title)).toEqual([
      "Provisioned policy",
    ])
    for (const [user, id] of [
      [admin, own.id],
      [ben, bens.id],
    ] as const) {
      expect((await node(user, id))?.documents).toEqual([])
    }
  })
})

describe("moving between Personal and Shared", () => {
  it("Shared -> Personal refused when the tree holds another person's page, allowed when all mine", async () => {
    const top = await shared(ana, "Was shared")
    const sub = await shared(ana, "Was shared, below", top.id)
    const bens = await page(ben, "Ben's page", { in: sub.id, access: "none" })
    const mine = await page(ana, "Ana's page", { in: top.id })
    const toPersonal = () =>
      as(ana, (tx, a) => updateKnowledgeCollection(tx, top.id, { ownerUserId: ana }, a))
    expect(await refusal(toPersonal())).toMatch(/belongs to another person/)
    expect((await folderRow(top.id))?.owner_user_id).toBeNull()

    await as(ben, (tx, a) =>
      removeCollectionMembership(
        tx,
        { collectionId: sub.id, targetType: "document", targetId: bens },
        a,
      ),
    )
    await toPersonal()
    expect((await folderRow(top.id))?.owner_user_id).toBe(ana)
    expect((await folderRow(sub.id))?.owner_user_id).toBe(ana)
    expect(await node(ben, top.id)).toBeUndefined()
    // The page keeps its sharing.
    expect(await inUnfiled(ben, mine)).toEqual({ tree: true, list: true })

    await as(ana, (tx, a) => updateKnowledgeCollection(tx, top.id, { ownerUserId: null }, a))
    expect(await folderRow(sub.id)).toEqual({
      name: "Was shared, below",
      owner_user_id: null,
      parent_collection_id: top.id,
      archived: false,
    })
    expect(has(await node(ben, top.id), mine)).toBe(true)
  })

  it("moving a folder into another section gives its whole tree to that section", async () => {
    const mine = await personal(ana, "Ana's own")
    const below = await personal(ana, "Ana's own, below", mine.id)
    const team = await shared(ana, "Team")
    await as(ana, (tx, a) =>
      updateKnowledgeCollection(tx, mine.id, { parentCollectionId: team.id }, a),
    )
    expect((await folderRow(mine.id))?.owner_user_id).toBeNull()
    expect((await folderRow(below.id))?.owner_user_id).toBeNull()
    expect((await folderRow(below.id))?.archived).toBe(false)
  })

  it("a subfolder cannot leave its parent's section on its own", async () => {
    const team = await shared(ana, "Team two")
    const sub = await shared(ana, "Team two, below", team.id)
    expect(
      await refusal(
        as(ana, (tx, a) => updateKnowledgeCollection(tx, sub.id, { ownerUserId: ana }, a)),
      ),
    ).toMatch(/Move it out first/)
  })

  it("a folder moved into its own child is refused, readably", async () => {
    const a1 = await shared(ana, "Loop")
    const a2 = await shared(ana, "Loop below", a1.id)
    expect(
      await refusal(
        as(ana, (tx, a) => updateKnowledgeCollection(tx, a1.id, { parentCollectionId: a2.id }, a)),
      ),
    ).toMatch(/cycle is not allowed/)
  })
})

describe("a synced tree", () => {
  async function source(
    scope: "organization" | "personal",
    name: string,
  ): Promise<{ source: SyncedSourceRow; root: string; below: string }> {
    const created = await as(
      ana,
      (tx, a) =>
        createSyncedSource(
          tx,
          {
            appName: "google-drive",
            folderRef: `ref-${randomUUID()}`,
            displayName: name,
            scope,
            syncIntervalSeconds: 3600,
            defaultSensitivity: scope === "organization" ? "internal" : null,
          },
          a,
          { skipPrecheck: true },
        ),
      ADMIN,
    )
    const below = await withPrivilegedDb(orgId, "test-synced-folder", (tx) =>
      upsertSyncedCollection(tx, new Map(), {
        sourceId: created.id,
        orgId,
        externalId: "sub",
        name: `${name} below`,
        parentCollectionId: created.rootCollectionId,
        ownerUserId: created.ownerUserId,
      }),
    )
    return { source: created, root: created.rootCollectionId, below }
  }

  it("PATCH owner, PATCH parent, move to Personal, rename, delete, file into: refused on a synced root and on a folder under it, by route and by tool, owner unchanged", async () => {
    const { root, below } = await source("organization", "Company drive")
    const other = await shared(ana, "Ordinary")
    const mine = await personal(ana, "Ordinary and mine")
    const doc = await page(ana, "To file")
    for (const id of [root, below]) {
      const before = await folderRow(id)
      const service: Record<string, () => Promise<unknown>> = {
        owner: () => as(ana, (tx, a) => updateKnowledgeCollection(tx, id, { ownerUserId: ana }, a)),
        parent: () =>
          as(ana, (tx, a) =>
            updateKnowledgeCollection(tx, id, { parentCollectionId: other.id }, a),
          ),
        personal: () =>
          as(ana, (tx, a) => updateKnowledgeCollection(tx, id, { parentCollectionId: mine.id }, a)),
        rename: () => as(ana, (tx, a) => updateKnowledgeCollection(tx, id, { name: "x" }, a)),
        describe: () =>
          as(ana, (tx, a) => updateKnowledgeCollection(tx, id, { description: null }, a)),
        remove: () => as(ana, (tx, a) => archiveKnowledgeCollection(tx, id, a)),
        moveInto: () =>
          as(ana, (tx, a) =>
            updateKnowledgeCollection(tx, other.id, { parentCollectionId: id }, a),
          ),
        createUnder: () => shared(ana, "x", id),
        file: () =>
          as(ana, (tx, a) =>
            addCollectionMembership(
              tx,
              { collectionId: id, targetType: "document", targetId: doc },
              a,
            ),
          ),
        unfile: () =>
          as(ana, (tx, a) =>
            removeCollectionMembership(
              tx,
              { collectionId: id, targetType: "document", targetId: doc },
              a,
            ),
          ),
        toolRename: () => tool(ana, "knowledge_collection_update", { id, name: "x" }),
        toolOwner: () => tool(ana, "knowledge_collection_update", { id, ownerUserId: ana }),
        toolParent: () =>
          tool(ana, "knowledge_collection_update", { id, parentCollectionId: mine.id }),
        toolDelete: () => tool(ana, "knowledge_collection_delete", { id }),
        toolFile: () =>
          tool(ana, "knowledge_add_to_collection", { collectionId: id, documentId: doc }),
        toolUnfile: () =>
          tool(ana, "knowledge_remove_from_collection", { collectionId: id, documentId: doc }),
      }
      for (const [what, attempt] of Object.entries(service)) {
        expect({ what, answer: await refusal(attempt()) }).toEqual({
          what,
          answer:
            "This folder is synced from another app. Change it there, or stop the sync first.",
        })
      }
      expect(await folderRow(id)).toEqual(before)
    }
  })

  it("a tree that holds a synced folder keeps its section, and its other folders stay free", async () => {
    const { root } = await source("organization", "Nested drive")
    const top = await shared(ana, "Holds a drive")
    await privileged(
      sql`UPDATE ${knowledgeRel("collections")} SET parent_collection_id = ${top.id}::uuid WHERE id = ${root}::uuid`,
    )
    expect(
      await refusal(
        as(ana, (tx, a) => updateKnowledgeCollection(tx, top.id, { ownerUserId: ana }, a)),
      ),
    ).toMatch(/synced from another app/)
    await as(ana, (tx, a) => updateKnowledgeCollection(tx, top.id, { name: "Holds a drive 2" }, a))
    await as(ana, (tx, a) => archiveKnowledgeCollection(tx, top.id, a))
    expect(await folderRow(root)).toEqual({
      name: "Nested drive",
      owner_user_id: null,
      parent_collection_id: null,
      archived: false,
    })
  })

  it("nobody writes the sync's own marker by hand", async () => {
    const { source: s } = await source("organization", "Marked drive")
    expect(
      await refusal(
        folder(ben, { name: "Trap", ownerUserId: ben, description: `synced:${s.id}:other` }),
      ),
    ).toMatch(/reserved/)
    const f = await shared(ben, "Plain")
    expect(
      await refusal(
        as(ben, (tx, a) =>
          updateKnowledgeCollection(tx, f.id, { description: `synced:${s.id}:other` }, a),
        ),
      ),
    ).toMatch(/reserved/)
  })

  it("syncing again puts the root back where the source belongs", async () => {
    const { source: s, root } = await source("organization", "Revived drive")
    await privileged(
      sql`UPDATE ${knowledgeRel("synced_sources")} SET archived_at = now() WHERE id = ${s.id}::uuid`,
    )
    await privileged(
      sql`UPDATE ${knowledgeRel("collections")} SET owner_user_id = ${ben}::uuid WHERE id = ${root}::uuid`,
    )
    await reactivateSyncedSource(orgId, s.id)
    expect(await folderRow(root)).toEqual({
      name: "Revived drive",
      owner_user_id: null,
      parent_collection_id: null,
      archived: false,
    })
  })
})

describe("a lost owner", () => {
  it("erase A: B, an admin and the agent bridge read no name of A's folders, nothing is listed, a page A shared is in B's Unfiled", async () => {
    const gone = (await minimal.person(orgId, { name: "Gone" })).id
    const mine = await personal(gone, "Gone person's therapy notes")
    const below = await personal(gone, "Gone person's appeal", mine.id)
    const doc = await page(gone, "Shared by the gone person", { in: mine.id })
    const synced = await as(
      gone,
      (tx, a) =>
        createSyncedSource(
          tx,
          {
            appName: "google-drive",
            folderRef: `ref-${randomUUID()}`,
            displayName: "Gone person's drive",
            scope: "personal",
            syncIntervalSeconds: 3600,
            defaultSensitivity: null,
          },
          a,
          { skipPrecheck: true },
        ),
      ADMIN,
    )

    expect(await eraseUser(gone)).toMatchObject({ exitCode: 0 })

    for (const [reader, scopes] of [
      [ben, MEMBER],
      [admin, ADMIN],
    ] as const) {
      const seen = JSON.stringify([
        await as(reader, (tx, a) => listKnowledgeCollections(tx, a), [...scopes]),
        await tree(reader, [...scopes]),
        await as(
          reader,
          async (tx) =>
            extractRows(
              await tx.execute(
                sql`SELECT name, description FROM ${knowledgeRel("collections")} WHERE id IN (${mine.id}::uuid, ${below.id}::uuid, ${synced.rootCollectionId}::uuid)`,
              ),
            ),
          [...scopes],
        ),
        await as(
          reader,
          async (tx) =>
            extractRows(
              await tx.execute(
                sql`SELECT * FROM ${knowledgeRel("synced_sources")} WHERE id = ${synced.id}::uuid`,
              ),
            ),
          [...scopes],
        ),
      ])
      for (const secret of ["Gone person", synced.folderRef]) expect(seen).not.toContain(secret)
      expect(nodes(await tree(reader, [...scopes])).map((n) => n.id)).not.toContain(mine.id)
    }
    const listing = await tool(ben, "knowledge_create", {
      title: "x",
      body: "x",
      documentScope: "organization",
    }).catch((e: Error) => e.message)
    expect(listing).not.toContain("Gone person")
    expect(listing).not.toContain("Deleted folder")
    expect(await inUnfiled(ben, doc)).toEqual({ tree: true, list: true })

    // A sync run after the erase un-archives nothing.
    await runSyncWorker({ sourceId: synced.id, trigger: "schedule" })
    for (const id of [mine.id, below.id, synced.rootCollectionId]) {
      expect(await folderRow(id)).toMatchObject({
        name: "Deleted folder",
        owner_user_id: null,
        archived: true,
      })
    }
  })

  it("A moving their own folder to Shared keeps its name and stays live", async () => {
    const mine = await personal(ana, "Ana's handbook")
    await as(ana, (tx, a) => updateKnowledgeCollection(tx, mine.id, { ownerUserId: null }, a))
    expect(await folderRow(mine.id)).toEqual({
      name: "Ana's handbook",
      owner_user_id: null,
      parent_collection_id: null,
      archived: false,
    })
  })
})
