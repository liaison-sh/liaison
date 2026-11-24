// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Folder pages (S20) on a real database, over HTTP with the scopes the real role
 * carries, and through the agent tools.
 *
 * - A folder has no page until someone writes in it. The first edit makes one
 *   ordinary page, titled as the folder, filed in it, with its own sharing:
 *   everyone may edit it in a shared folder, nobody else sees it in a personal one.
 *   However many first edits arrive at once, there is one page.
 * - The folder page lists what is directly inside that the reader may open:
 *   folders and pages. The page itself is not in that list, nor in the sidebar's
 *   list of the folder. A reader who may not open the page still gets the list,
 *   and nothing of the page.
 * - Renaming the folder renames its page, and renaming the page renames the folder.
 * - Moving the page to Trash, or out of its folder, makes it an ordinary page and
 *   leaves the folder without one. Deleting the folder makes a page with text an
 *   ordinary page of the parent folder (or Unfiled), and moves an empty one to Trash.
 * - A synced folder has no page. Agents read and update the page like any other.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { app } from "~/app"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { knowledgeActorFromContext } from "~/apps/knowledge/service"
import { createSyncedSource } from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(120_000)

let orgId: string
let anaId: string
let benId: string
let adminId: string
let ana: minimal.Session
let ben: minimal.Session

beforeAll(async () => {
  await acquireTestLock()
  initializedOrgRuntimes.clear()
  orgId = (await createTestOrg()).id
  adminId = (await minimal.orgAdmin(orgId)).id
  const member = async (name: string) => {
    const p = await minimal.person(orgId, { name })
    await minimal.assignRole(p.id, "Full Member")
    return p
  }
  const a = await member("Ana")
  const b = await member("Ben")
  // Ana may also move pages to the Trash; Ben may not.
  await minimal.grantScope(a.id, "knowledge:documents:archive")
  anaId = a.id
  benId = b.id
  ana = await minimal.sessionOf(a)
  ben = await minimal.sessionOf(b)
})
afterAll(releaseTestLock)

interface Answer<T = Record<string, unknown>> {
  status: number
  text: string
  data: T
  error?: { message: string; code?: string }
}

async function call<T = Record<string, unknown>>(
  who: minimal.Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer<T>> {
  const res = await app.request(`/api/knowledge${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  const json = text ? (JSON.parse(text) as { data?: T; error?: Answer["error"] }) : {}
  return { status: res.status, text, data: json.data as T, error: json.error }
}

interface Doc {
  id: string
  title: string
  body: string
  revision: number
  orgAccess: string
  archivedAt: string | null
  canEdit?: boolean
}

interface FolderPage {
  folder: { id: string; name: string; parentId: string | null; synced: boolean }
  page: Doc | null
  canStartPage: boolean
  folders: Array<{ id: string; name: string }>
  pages: Array<{ id: string; title: string }>
  more: boolean
}

async function folder(who: minimal.Session, name: string, extra: object = {}): Promise<string> {
  const made = await call(who, "POST", "/collections", { name, ownerUserId: null, ...extra })
  expect({ name, status: made.status, error: made.error }).toEqual({
    name,
    status: 201,
    error: undefined,
  })
  return made.data.id as string
}

async function page(who: minimal.Session, title: string, extra: object = {}): Promise<string> {
  const made = await call(who, "POST", "/documents", {
    title,
    body: "body",
    documentScope: "organization",
    orgAccess: "editor",
    ...extra,
  })
  expect({ title, status: made.status, error: made.error }).toEqual({
    title,
    status: 201,
    error: undefined,
  })
  return made.data.id as string
}

/** The first edit of a folder's page: makes it when it does not exist yet. */
async function start(who: minimal.Session, folderId: string, body?: string): Promise<Answer<Doc>> {
  return call<Doc>(who, "POST", `/collections/${folderId}/page`, body === undefined ? {} : { body })
}

async function view(who: minimal.Session, folderId: string): Promise<Answer<FolderPage>> {
  return call<FolderPage>(who, "GET", `/collections/${folderId}/page`)
}

async function patchDoc(who: minimal.Session, id: string, fields: Record<string, unknown>) {
  const doc = (await call<Doc>(who, "GET", `/documents/${id}`)).data
  const res = await call<Doc>(who, "PATCH", `/documents/${id}`, {
    revision: doc.revision,
    ...fields,
  })
  expect({ status: res.status, error: res.error }).toEqual({ status: 200, error: undefined })
  return res.data
}

interface StoredFolder {
  name: string
  index_document_id: string | null
  archived_at: string | null
}
async function storedFolder(id: string): Promise<StoredFolder> {
  const [row] = extractRows<StoredFolder>(
    await withPrivilegedDb(orgId, "test-folder-page", (tx) =>
      tx.execute(sql`
        SELECT name, index_document_id::text AS index_document_id, archived_at::text AS archived_at
          FROM ${knowledgeRel("collections")} WHERE id = ${id}::uuid`),
    ),
  )
  if (!row) throw new Error("no such folder")
  return row
}

interface StoredDoc {
  title: string
  body: string
  org_access: string
  archived_at: string | null
}
async function storedDoc(id: string): Promise<StoredDoc> {
  const [row] = extractRows<StoredDoc>(
    await withPrivilegedDb(orgId, "test-folder-page", (tx) =>
      tx.execute(sql`
        SELECT title, body, org_access, archived_at::text AS archived_at
          FROM ${knowledgeRel("documents")} WHERE id = ${id}::uuid`),
    ),
  )
  if (!row) throw new Error("no such page")
  return row
}

async function foldersOf(docId: string): Promise<string[]> {
  return extractRows<{ id: string }>(
    await withPrivilegedDb(orgId, "test-folder-page", (tx) =>
      tx.execute(sql`
        SELECT collection_id::text AS id FROM ${knowledgeRel("collection_memberships")}
         WHERE target_id = ${docId}::uuid ORDER BY 1`),
    ),
  ).map((r) => r.id)
}

async function pagesTitled(title: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await withPrivilegedDb(orgId, "test-folder-page", (tx) =>
      tx.execute(sql`
        SELECT count(*)::int AS n FROM ${knowledgeRel("documents")}
         WHERE org_id = ${orgId}::uuid AND title = ${title}`),
    ),
  )
  return row?.n ?? 0
}

interface TreeNode {
  id: string
  indexDocumentId?: string | null
  children: TreeNode[]
  documents: Array<{ id: string }>
}
async function treeNode(who: minimal.Session, id: string): Promise<TreeNode | undefined> {
  const roots = (await call<TreeNode[]>(who, "GET", "/collections/tree")).data
  const walk = (nodes: TreeNode[]): TreeNode | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n
      const found = walk(n.children)
      if (found) return found
    }
    return undefined
  }
  return walk(roots)
}
async function unfiledIds(who: minimal.Session): Promise<string[]> {
  return (await call<Doc[]>(who, "GET", "/documents?filter=unfiled")).data.map((d) => d.id)
}

async function actorOf(userId: string) {
  const perms = await withPrivilegedDb(orgId, "test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    orgId,
    userId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  }
}

async function tool<T>(userId: string, toolName: string, params: Record<string, unknown>) {
  const res = await executeTool<T>({
    toolName,
    orgId,
    actor: await actorOf(userId),
    params,
    threadId: await minimal.thread(orgId, userId, { title: toolName }),
    origin: "in-app-agent",
    stepBundleId: null,
  } as never)
  return res.data as T
}

describe("the first edit makes the folder's page", () => {
  it("one page titled as the folder, filed in it, editable by everyone in a shared folder", async () => {
    const id = await folder(ana, "Policies")
    const before = await view(ana, id)
    expect(before.status).toBe(200)
    expect(before.data.page).toBeNull()
    expect(before.data.canStartPage).toBe(true)
    expect((await storedFolder(id)).index_document_id).toBeNull()

    const made = await start(ana, id, "How we work")
    expect({ status: made.status, error: made.error }).toEqual({ status: 201, error: undefined })
    expect(made.data.title).toBe("Policies")
    expect(made.data.body).toBe("How we work")
    expect(made.data.orgAccess).toBe("editor")
    expect((await storedFolder(id)).index_document_id).toBe(made.data.id)
    expect(await foldersOf(made.data.id)).toEqual([id])

    // A second first edit (another tab, a retry) gets the same page, text unchanged.
    const again = await start(ana, id, "other text")
    expect(again.status).toBe(200)
    expect(again.data.id).toBe(made.data.id)
    expect((await storedDoc(made.data.id)).body).toBe("How we work")

    // Ben, a member, sees it and may edit it: it is an ordinary page.
    const benView = await view(ben, id)
    expect(benView.data.page?.id).toBe(made.data.id)
    expect(benView.data.page?.canEdit).toBe(true)
    expect(benView.data.canStartPage).toBe(false)
    await patchDoc(ben, made.data.id, { body: "How we work, by Ben" })
  })

  it("a personal folder's page is seen by its owner only", async () => {
    const id = await folder(ana, "Ana's notes", { ownerUserId: anaId })
    const made = await start(ana, id)
    expect(made.status).toBe(201)
    expect(made.data.orgAccess).toBe("none")
    expect(made.data.body).toBe("")
    expect((await call(ben, "GET", `/documents/${made.data.id}`)).status).toBe(404)
    expect((await view(ben, id)).status).toBe(404)
    expect((await start(ben, id)).status).toBe(404)
  })

  it("many first edits at once make one page", async () => {
    const name = `Race ${randomUUID().slice(0, 8)}`
    const id = await folder(ana, name)
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => start(i % 2 ? ben : ana, id, `text ${i}`)),
    )
    for (const a of answers) expect(a.status === 200 || a.status === 201).toBe(true)
    const ids = new Set(answers.map((a) => a.data.id))
    expect(ids.size).toBe(1)
    expect(answers.filter((a) => a.status === 201)).toHaveLength(1)
    expect(await pagesTitled(name)).toBe(1)
    expect((await storedFolder(id)).index_document_id).toBe([...ids][0] ?? null)
  })

  it("needs the folder scope and the create scope, and a folder the person sees", async () => {
    const id = await folder(ana, "Scoped")
    const reader = await minimal.person(orgId, { name: "Reader" })
    await minimal.grantScope(reader.id, "knowledge:documents:read")
    await minimal.grantScope(reader.id, "knowledge:documents:create")
    const readerSession = await minimal.sessionOf(reader)
    const noFolderScope = await start(readerSession, id)
    expect(noFolderScope.status).toBe(403)
    expect((await storedFolder(id)).index_document_id).toBeNull()

    const filer = await minimal.person(orgId, { name: "Filer" })
    await minimal.grantScope(filer.id, "knowledge:documents:read")
    await minimal.grantScope(filer.id, "knowledge:collections:manage")
    const filerSession = await minimal.sessionOf(filer)
    expect((await view(filerSession, id)).data.canStartPage).toBe(false)
    expect((await start(filerSession, id)).status).toBe(403)
    expect((await storedFolder(id)).index_document_id).toBeNull()

    expect((await start(ana, randomUUID())).status).toBe(404)
    const gone = await folder(ana, "Gone")
    expect((await call(ana, "POST", `/collections/${gone}/archive`, {})).status).toBe(200)
    expect((await start(ana, gone)).status).toBe(404)
    expect((await view(ana, gone)).status).toBe(404)
  })
})

describe("the content list", () => {
  it("shows what is directly inside that the reader may open, never the page itself", async () => {
    const top = await folder(ana, "Handbook")
    const sub = await folder(ana, "Onboarding", { parentCollectionId: top })
    const deep = await folder(ana, "Deep", { parentCollectionId: sub })
    const open = await page(ana, "Open page", { collectionIds: [top] })
    const hidden = await page(ana, "Hidden page Quokka", {
      orgAccess: "none",
      collectionIds: [top],
    })
    const below = await page(ana, "Below", { collectionIds: [sub] })
    const index = (await start(ana, top, "Welcome")).data.id

    const anaView = (await view(ana, top)).data
    expect(anaView.folder).toMatchObject({ id: top, name: "Handbook", synced: false })
    expect(anaView.folders.map((f) => f.id)).toEqual([sub])
    expect(anaView.pages.map((p) => p.id).sort()).toEqual([hidden, open].sort())
    expect(anaView.more).toBe(false)

    const benView = await view(ben, top)
    expect(benView.data.folders.map((f) => f.id)).toEqual([sub])
    expect(benView.data.pages.map((p) => p.id)).toEqual([open])
    expect(benView.text).not.toContain("Quokka")
    expect(benView.text).not.toContain(deep)
    expect(benView.text).not.toContain(below)

    // The sidebar names the folder's page and leaves it out of the folder's pages.
    const node = await treeNode(ana, top)
    expect(node?.indexDocumentId).toBe(index)
    expect(node?.documents.map((d) => d.id)).not.toContain(index)
    expect(await unfiledIds(ana)).not.toContain(index)
  })

  it("a reader who may not open the page gets the list, and no title or body of the page", async () => {
    const id = await folder(ana, "Board")
    const inside = await page(ana, "Agenda", { collectionIds: [id] })
    const index = (await start(ana, id, "Minutes Wombat")).data.id
    await patchDoc(ana, index, { orgAccess: "none" })

    const benView = await view(ben, id)
    expect(benView.status).toBe(200)
    expect(benView.data.page).toBeNull()
    expect(benView.data.canStartPage).toBe(false)
    expect(benView.data.pages.map((p) => p.id)).toEqual([inside])
    expect(benView.text).not.toContain("Wombat")
    expect(benView.text).not.toContain(index)

    const node = await treeNode(ben, id)
    expect(node?.indexDocumentId ?? null).toBeNull()
    expect(JSON.stringify(node)).not.toContain(index)
    const listed = await call(ben, "GET", "/collections")
    expect(listed.text).not.toContain(index)
    expect(await unfiledIds(ben)).not.toContain(index)
    // Starting another page is refused, and says nothing of the one there.
    const refused = await start(ben, id)
    expect(refused.status).toBe(404)
    expect(refused.text).not.toContain("Wombat")
  })
})

describe("names follow each other", () => {
  it("renaming the folder renames its page, and renaming the page renames the folder", async () => {
    const id = await folder(ana, "Sales")
    const index = (await start(ana, id, "text")).data.id
    expect((await call(ben, "PATCH", `/collections/${id}`, { name: "Sales team" })).status).toBe(
      200,
    )
    expect((await storedDoc(index)).title).toBe("Sales team")
    expect((await storedDoc(index)).body).toBe("text")

    await patchDoc(ben, index, { title: "Sales and partners" })
    expect((await storedFolder(id)).name).toBe("Sales and partners")

    // An ordinary page in the folder renames nothing.
    const other = await page(ana, "Other", { collectionIds: [id] })
    await patchDoc(ana, other, { title: "Other renamed" })
    expect((await storedFolder(id)).name).toBe("Sales and partners")
  })

  it("a page renamed by someone who may not manage folders: saved, the folder keeps its name", async () => {
    const id = await folder(ana, "Clerk desk")
    const index = (await start(ana, id, "text")).data.id
    const clerk = await minimal.person(orgId, { name: "Desk clerk" })
    for (const scope of ["knowledge:documents:read", "knowledge:documents:update"]) {
      await minimal.grantScope(clerk.id, scope)
    }
    const session = await minimal.sessionOf(clerk)
    await patchDoc(session, index, { title: "Clerk's title" })
    expect((await storedDoc(index)).title).toBe("Clerk's title")
    expect((await storedFolder(id)).name).toBe("Clerk desk")
  })

  it("a folder rename keeps a verified page verified; a title edit of the page does not", async () => {
    const id = await folder(ana, "Policies")
    const index = (await start(ana, id, "text")).data.id
    const verify = () =>
      withPrivilegedDb(orgId, "test-verify", (tx) =>
        tx.execute(sql`UPDATE ${knowledgeRel("documents")} SET review_status = 'verified'
                        WHERE id = ${index}::uuid`),
      )
    const review = async () =>
      extractRows<{ s: string }>(
        await withPrivilegedDb(orgId, "test-review", (tx) =>
          tx.execute(sql`SELECT review_status AS s FROM ${knowledgeRel("documents")}
                          WHERE id = ${index}::uuid`),
        ),
      )[0]?.s
    await verify()
    expect((await call(ana, "PATCH", `/collections/${id}`, { name: "Policies 2026" })).status).toBe(
      200,
    )
    expect((await storedDoc(index)).title).toBe("Policies 2026")
    expect(await review()).toBe("verified")
    await patchDoc(ana, index, { title: "Policies and rules" })
    expect(await review()).toBe("needs_review")
  })

  it("a folder renamed by someone who may not edit its page keeps the page's title", async () => {
    const id = await folder(ana, "Legal")
    const index = (await start(ana, id, "text")).data.id
    await patchDoc(ana, index, { orgAccess: "viewer" })
    expect((await call(ben, "PATCH", `/collections/${id}`, { name: "Legal desk" })).status).toBe(
      200,
    )
    expect((await storedFolder(id)).name).toBe("Legal desk")
    expect((await storedDoc(index)).title).toBe("Legal")
  })
})

describe("concurrent writes on a folder and its page never deadlock", () => {
  const ROUNDS = 25

  it("renaming the folder and its page at once: 200 or 409, never 500, names agree", async () => {
    const id = await folder(ana, "Race")
    const index = (await start(ana, id, "text")).data.id
    const statuses: number[] = []
    for (let i = 0; i < ROUNDS; i++) {
      const doc = (await call<Doc>(ben, "GET", `/documents/${index}`)).data
      const [byFolder, byPage] = await Promise.all([
        call(ana, "PATCH", `/collections/${id}`, { name: `Race folder ${i}` }),
        call(ben, "PATCH", `/documents/${index}`, {
          revision: doc.revision,
          title: `Race page ${i}`,
        }),
      ])
      statuses.push(byFolder.status, byPage.status)
      expect((await storedFolder(id)).name).toBe((await storedDoc(index)).title)
    }
    expect(statuses.filter((s) => s !== 200 && s !== 409)).toEqual([])
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(ROUNDS)
  })

  it("deleting the folder while its page goes to Trash: 200 both, never 500", async () => {
    const statuses: number[] = []
    for (let i = 0; i < ROUNDS; i++) {
      const id = await folder(ana, `Race delete ${i}`)
      const index = (await start(ana, id)).data.id
      const [del, trash] = await Promise.all([
        call(ana, "POST", `/collections/${id}/archive`, {}),
        call(ana, "POST", `/documents/${index}/archive`, {}),
      ])
      statuses.push(del.status, trash.status)
      expect((await storedFolder(id)).archived_at).not.toBeNull()
      expect((await storedFolder(id)).index_document_id).toBeNull()
      expect((await storedDoc(index)).archived_at).not.toBeNull()
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([])
  })

  it("moving the page out while the folder is renamed or deleted: never 500", async () => {
    const statuses: number[] = []
    for (let i = 0; i < ROUNDS; i++) {
      const id = await folder(ana, `Race move ${i}`)
      const index = (await start(ana, id, "text")).data.id
      const [renamed, moved] = await Promise.all([
        i % 2 === 0
          ? call(ana, "PATCH", `/collections/${id}`, { name: `Race moved ${i}` })
          : call(ana, "POST", `/collections/${id}/archive`, {}),
        call(ben, "POST", `/documents/${index}/move`, {
          fromCollectionId: id,
          toCollectionId: null,
        }),
      ])
      statuses.push(renamed.status, moved.status)
      expect((await storedFolder(id)).index_document_id).toBeNull()
    }
    expect(statuses.filter((s) => s >= 500)).toEqual([])
  })
})

describe("the page leaves its folder", () => {
  it("moved to Trash: the folder has no page, the restored page is an ordinary one", async () => {
    const id = await folder(ana, "Support")
    const index = (await start(ana, id, "text")).data.id
    expect((await call(ana, "POST", `/documents/${index}/archive`, {})).status).toBe(200)
    expect((await storedFolder(id)).index_document_id).toBeNull()
    const after = (await view(ana, id)).data
    expect(after.page).toBeNull()
    expect(after.canStartPage).toBe(true)

    expect((await call(ana, "POST", `/documents/${index}/restore`, {})).status).toBe(200)
    expect((await view(ana, id)).data.pages.map((p) => p.id)).toEqual([index])
    // A new first edit makes a new page.
    const fresh = await start(ana, id, "new")
    expect(fresh.status).toBe(201)
    expect(fresh.data.id).not.toBe(index)
  })

  it("moved to Trash by someone who may not manage folders: it no longer counts", async () => {
    const id = await folder(ana, "Archive desk")
    const index = (await start(ana, id, "text")).data.id
    const clerk = await minimal.person(orgId, { name: "Clerk" })
    for (const scope of [
      "knowledge:documents:read",
      "knowledge:documents:update",
      "knowledge:documents:archive",
    ]) {
      await minimal.grantScope(clerk.id, scope)
    }
    const trashed = await call(
      await minimal.sessionOf(clerk),
      "POST",
      `/documents/${index}/archive`,
      {},
    )
    expect(trashed.status).toBe(200)
    // The clerk could not write the folder: it still points at the page in Trash.
    expect((await storedFolder(id)).index_document_id).toBe(index)
    const seen = (await view(ana, id)).data
    expect(seen.page).toBeNull()
    expect(seen.canStartPage).toBe(true)
    expect((await treeNode(ana, id))?.indexDocumentId ?? null).toBeNull()
    const fresh = await start(ana, id, "again")
    expect(fresh.status).toBe(201)
    expect((await storedFolder(id)).index_document_id).toBe(fresh.data.id)
  })

  it("moved out of its folder: the folder has no page", async () => {
    const id = await folder(ana, "Ops")
    const elsewhere = await folder(ana, "Elsewhere")
    const index = (await start(ana, id, "text")).data.id
    const moved = await call(ben, "POST", `/documents/${index}/move`, {
      fromCollectionId: id,
      toCollectionId: elsewhere,
    })
    expect(moved.status).toBe(200)
    expect((await storedFolder(id)).index_document_id).toBeNull()
    expect((await view(ana, elsewhere)).data.pages.map((p) => p.id)).toEqual([index])
  })

  it("taken out of its folder: the folder has no page", async () => {
    const id = await folder(ana, "Ops two")
    const index = (await start(ana, id, "text")).data.id
    const removed = await call(ben, "DELETE", `/collections/${id}/members`, {
      targetType: "document",
      targetId: index,
    })
    expect(removed.status).toBe(200)
    expect((await storedFolder(id)).index_document_id).toBeNull()
  })
})

describe("deleting the folder", () => {
  it("a page with text becomes an ordinary page of the parent folder", async () => {
    const top = await folder(ana, "Company")
    const sub = await folder(ana, "Finance", { parentCollectionId: top })
    const index = (await start(ana, sub, "Budget rules")).data.id
    expect((await call(ana, "POST", `/collections/${sub}/archive`, {})).status).toBe(200)
    expect((await storedFolder(sub)).index_document_id).toBeNull()
    const doc = await storedDoc(index)
    expect(doc.archived_at).toBeNull()
    expect(doc.title).toBe("Finance")
    expect(await foldersOf(index)).toEqual([top])
    expect((await view(ana, top)).data.pages.map((p) => p.id)).toEqual([index])
  })

  it("a page with text at the top becomes Unfiled", async () => {
    const id = await folder(ana, "Top with text")
    const index = (await start(ana, id, "text")).data.id
    expect((await call(ben, "POST", `/collections/${id}/archive`, {})).status).toBe(200)
    expect((await storedDoc(index)).archived_at).toBeNull()
    expect(await unfiledIds(ben)).toContain(index)
  })

  it("an empty page goes to Trash", async () => {
    const id = await folder(ana, "Empty")
    const index = (await start(ana, id, "")).data.id
    await patchDoc(ana, index, { body: "  \n" })
    expect((await call(ana, "POST", `/collections/${id}/archive`, {})).status).toBe(200)
    // Moving to Trash is archiving the page (its clock is the Trash's own concern).
    expect((await storedDoc(index)).archived_at).not.toBeNull()
  })

  it("an empty page stays, an ordinary page, when the person deleting may not trash it", async () => {
    const id = await folder(ana, "Empty kept")
    const index = (await start(ana, id)).data.id
    expect((await call(ben, "POST", `/collections/${id}/archive`, {})).status).toBe(200)
    expect((await storedDoc(index)).archived_at).toBeNull()
    expect((await storedFolder(id)).index_document_id).toBeNull()
  })
})

describe("a synced folder", () => {
  it("has no page: starting one is refused, the view offers none", async () => {
    const ctx = { orgId, userId: adminId, scopes: ["*"], dimensionGrants: { "*": ["*"] } }
    const source = await withRlsContext({ actorType: "user" as const, ...ctx }, (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: `ref-${randomUUID()}`,
          displayName: "Drive",
          scope: "organization",
          syncIntervalSeconds: 3600,
          defaultSensitivity: "internal",
        },
        knowledgeActorFromContext(ctx),
        { skipPrecheck: true },
      ),
    )
    const root = source.rootCollectionId
    const refused = await start(ana, root, "text")
    expect(refused.status).toBe(400)
    expect((await storedFolder(root)).index_document_id).toBeNull()
    const seen = (await view(ana, root)).data
    expect(seen.folder.synced).toBe(true)
    expect(seen.page).toBeNull()
    expect(seen.canStartPage).toBe(false)
  })
})

describe("agents", () => {
  it("read and update the folder's page like any page", async () => {
    const id = await folder(ana, "Agent folder")
    const index = (await start(ana, id, "Start")).data.id
    const got = await tool<{ document?: Doc }>(anaId, "knowledge:get", { id: index })
    expect(got.document?.body).toBe("Start")
    await tool(anaId, "knowledge:update", {
      id: index,
      revision: got.document?.revision,
      body: "Written by the agent",
      title: "Agent folder renamed",
    })
    const doc = await storedDoc(index)
    expect(doc.body).toBe("Written by the agent")
    expect((await storedFolder(id)).name).toBe("Agent folder renamed")
    const benGot = await tool<{ document?: Doc }>(benId, "knowledge:get", { id: index })
    expect(benGot.document?.body).toBe("Written by the agent")
  })
})
