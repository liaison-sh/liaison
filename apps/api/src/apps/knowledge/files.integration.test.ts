// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Images and files of a page (S11, edges 8 and 9), through the HTTP API and the
 * service with real tokens and the real row security.
 *
 * - Adding or removing a file on a page needs the edit right on that page, not only
 *   the update scope: a person who only reads the page is refused (upload, upload
 *   session, move, attach, delete). The Knowledge import's own attach is the one
 *   caller that skips the edit check (`destinationAuthorized`), and only that check.
 * - A page's file is read by the readers of the page and nobody else; a removed
 *   share removes the file with it.
 * - A save that names another page's file stores a copy of it on this page and its
 *   own id (people, agents, create and update), once; a file the writer cannot read
 *   is kept byte for byte and copied by nobody; a copy over the quota is reported,
 *   the text is still saved, and the next save tries again.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { app } from "~/app"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import { KnowledgeFileAdoptionTestAccess } from "~/apps/knowledge/body-tokens"
import { sweepUnparentedPageCopies } from "~/apps/knowledge/page-file-sweep"
import {
  createKnowledgeDocument,
  knowledgeActorFromContext,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { documentTemplates } from "~/db/schema/kernel/document-templates"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { attachFileToParent } from "~/modules/files/attach"
import {
  authorizeUpload,
  createUploadSession,
  deleteFile,
  FileServiceError,
  moveFilesToParent,
} from "~/modules/files/service"
import { seedFileRow } from "~/seed/factories/files/file-row"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(120_000)

let orgId: string
let editor: minimal.Session
let viewer: minimal.Session
let outsider: minimal.Session

const SCOPES = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
  "knowledge:attachments:upload",
  "knowledge:attachments:download",
]

const copies: Array<{ sourceKey: string; destKey: string }> = []

beforeAll(async () => {
  await acquireTestLock()
  initializedOrgRuntimes.clear()
  orgId = (await createTestOrg()).id
  const e = await minimal.person(orgId, { name: "Editor" })
  const v = await minimal.person(orgId, { name: "Viewer" })
  const o = await minimal.person(orgId, { name: "Outsider" })
  for (const s of SCOPES) {
    await minimal.grantScope(e.id, s)
    await minimal.grantScope(v.id, s)
    await minimal.grantScope(o.id, s)
  }
  editor = await minimal.sessionOf(e)
  viewer = await minimal.sessionOf(v)
  outsider = await minimal.sessionOf(o)
  KnowledgeFileAdoptionTestAccess.setCopyObject(async (args) => {
    copies.push(args)
  })
})
afterEach(() => {
  copies.length = 0
})
afterAll(async () => {
  KnowledgeFileAdoptionTestAccess.setCopyObject(null)
  await releaseTestLock()
})

async function call(
  who: minimal.Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: { data?: unknown } }> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.bearer}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: { data?: unknown } = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    // a byte stream
  }
  return { status: res.status, text, json }
}

interface Doc {
  id: string
  revision: number
  body: string
  fileIdMap?: Record<string, string>
  notCopied?: Array<{ id: string; reason: string }>
}

async function page(who: minimal.Session, input: Record<string, unknown> = {}): Promise<Doc> {
  const res = await call(who, "POST", "/knowledge/documents", {
    title: "Page",
    body: "start",
    documentScope: "organization",
    orgAccess: "viewer",
    ...input,
  })
  expect(res.status).toBe(201)
  return res.json.data as Doc
}

async function current(who: minimal.Session, id: string): Promise<Doc> {
  return (await call(who, "GET", `/knowledge/documents/${id}`)).json.data as Doc
}

async function save(who: minimal.Session, id: string, body: string): Promise<Doc> {
  const doc = await current(who, id)
  const res = await call(who, "PATCH", `/knowledge/documents/${id}`, {
    revision: doc.revision,
    body,
  })
  expect(res.status).toBe(200)
  return res.json.data as Doc
}

/** A stored file row on a page (the bytes are never read by these tests). */
async function fileOn(docId: string, opts: { size?: number; uploadedBy?: string } = {}) {
  return seedFileRow({
    orgId,
    app: "knowledge",
    entityType: "document",
    entityId: docId,
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: opts.size ?? 10,
    storageKey: `test/${randomUUID()}/diagram.png`,
    uploadedBy: opts.uploadedBy ?? editor.userId,
  })
}

async function filesOf(docId: string) {
  return extractRows<{ id: string; copied_from_id: string | null }>(
    await withPrivilegedDb(orgId, "test-files-of", (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, copied_from_id::text AS copied_from_id FROM kernel.files
         WHERE org_id = ${orgId}::uuid AND app = 'knowledge' AND entity_type = 'document'
           AND entity_id = ${docId}
         ORDER BY created_at, id`),
    ),
  )
}

async function storedBody(docId: string): Promise<string> {
  const [row] = extractRows<{ body: string }>(
    await withPrivilegedDb(orgId, "test-body", (tx) =>
      tx.execute(sql`SELECT body FROM app_knowledge.documents WHERE id = ${docId}::uuid`),
    ),
  )
  return row?.body ?? ""
}

function rlsOf(who: minimal.Session) {
  return {
    actorType: "user" as const,
    orgId,
    userId: who.userId,
    scopes: SCOPES,
    dimensionGrants: {},
  }
}

function privileged<T>(reason: string, fn: Parameters<typeof withPrivilegedDb<T>>[2]) {
  return withPrivilegedDb(orgId, reason, fn)
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    return err instanceof FileServiceError ? err.code : String(err)
  }
  return "allowed"
}

const tokenOf = (id: string) => `![](liaison-file:${id})`

describe("adding and removing a page's files needs the edit right", () => {
  it("a reader holding the update scope is refused everywhere; the editor is not", async () => {
    const doc = await page(editor) // the whole org reads it, only its author edits it
    const fileId = await fileOn(doc.id)
    const other = await page(viewer, { orgAccess: "none" })
    const viewersFile = await fileOn(other.id, { uploadedBy: viewer.userId })
    const target = { app: "knowledge", entityType: "document", entityId: doc.id }
    const upload = (who: minimal.Session) =>
      withRlsContext(rlsOf(who), (rlsTx) =>
        authorizeUpload(
          {
            orgId,
            userId: who.userId,
            scopes: SCOPES,
            ...target,
            filename: "note.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
          { rlsTx, privileged, presignPut: async () => "https://upload.test" },
        ),
      )

    expect(await refusal(upload(viewer))).toBe("FORBIDDEN")
    expect(await refusal(upload(editor))).toBe("allowed")
    expect(
      await refusal(
        withRlsContext(rlsOf(viewer), (rlsTx) =>
          createUploadSession(
            {
              orgId,
              userId: viewer.userId,
              scopes: SCOPES,
              targetApp: "knowledge",
              targetEntityType: "document",
              targetEntityId: doc.id,
            },
            { rlsTx, privileged },
          ),
        ),
      ),
    ).toBe("FORBIDDEN")
    // A session opened for no page yet, then moved onto a page the person only reads.
    const moved = await withRlsContext(rlsOf(viewer), async (rlsTx) => {
      const session = await createUploadSession(
        {
          orgId,
          userId: viewer.userId,
          scopes: SCOPES,
          targetApp: "knowledge",
          targetEntityType: "document",
          targetEntityId: null,
        },
        { rlsTx, privileged },
      )
      return refusal(
        moveFilesToParent(
          {
            orgId,
            userId: viewer.userId,
            scopes: SCOPES,
            sourceSessionId: session.id,
            target,
            fileIds: [],
          },
          { rlsTx, privileged },
        ),
      )
    })
    expect(moved).toBe("FORBIDDEN")
    expect(
      await refusal(
        withRlsContext(rlsOf(viewer), (rlsTx) =>
          attachFileToParent(
            { sourceFileId: viewersFile, target },
            {
              rlsTx,
              privileged,
              orgId,
              userId: viewer.userId,
              scopes: SCOPES,
              copyObject: async () => {},
            },
          ),
        ),
      ),
    ).toBe("FORBIDDEN")
    expect(
      await refusal(
        withRlsContext(rlsOf(viewer), (rlsTx) =>
          deleteFile(fileId, { orgId, userId: viewer.userId, scopes: SCOPES, rlsTx, privileged }),
        ),
      ),
    ).toBe("FORBIDDEN")
    expect((await filesOf(doc.id)).map((f) => f.id)).toEqual([fileId])
    expect(
      await refusal(
        withRlsContext(rlsOf(editor), (rlsTx) =>
          deleteFile(fileId, { orgId, userId: editor.userId, scopes: SCOPES, rlsTx, privileged }),
        ),
      ),
    ).toBe("allowed")
  })

  it("the import's flag skips the edit check only: the page must still be visible", async () => {
    const doc = await page(editor)
    const hidden = await page(editor, { orgAccess: "none" })
    const other = await page(viewer, { orgAccess: "none" })
    const viewersFile = await fileOn(other.id, { uploadedBy: viewer.userId })
    const attach = (entityId: string) =>
      withRlsContext(rlsOf(viewer), (rlsTx) =>
        attachFileToParent(
          {
            sourceFileId: viewersFile,
            target: { app: "knowledge", entityType: "document", entityId },
          },
          {
            rlsTx,
            privileged,
            orgId,
            userId: viewer.userId,
            scopes: SCOPES,
            copyObject: async () => {},
            destinationAuthorized: true,
          },
        ),
      )
    expect(await refusal(attach(doc.id))).toBe("allowed")
    expect(await refusal(attach(hidden.id))).toBe("PARENT_NOT_FOUND")
  })
})

describe("a page's file is read by the page's readers only", () => {
  it("a shared reader reads it; others get 404 on every route; unsharing removes it", async () => {
    const doc = await page(editor, { orgAccess: "none" })
    const fileId = await fileOn(doc.id)
    const share = (shares: Array<{ userId: string; role: "viewer" | "editor" }>) =>
      call(editor, "PUT", `/knowledge/documents/${doc.id}/sharing`, {
        orgAccess: "none",
        editScope: null,
        shares,
      })
    expect((await share([{ userId: viewer.userId, role: "viewer" }])).status).toBe(200)

    const routes = [
      `/files/${fileId}/metadata`,
      `/files/${fileId}/inline`,
      `/files/${fileId}/inline?variant=thumb`,
      `/files/${fileId}/download-url`,
    ]
    expect((await call(viewer, "GET", routes[0] ?? "")).status).toBe(200)
    expect((await call(editor, "GET", routes[0] ?? "")).status).toBe(200)
    for (const path of routes) {
      const res = await call(outsider, "GET", path)
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
    }

    expect((await share([])).status).toBe(200)
    for (const path of routes) {
      const res = await call(viewer, "GET", path)
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
    }
  })
})

describe("a save copies another page's files onto this page (K-R17)", () => {
  it("by PATCH: this page stores its own copy and id, once; the source page can go", async () => {
    const a = await page(editor)
    const fileA = await fileOn(a.id)
    const b = await page(editor, { body: "" })
    const text = `Before ${tokenOf(fileA)} after ![alt kept](liaison-file:${fileA})\n\`${tokenOf(fileA)}\``

    const saved = await save(editor, b.id, text)
    const own = await filesOf(b.id)
    expect(own).toHaveLength(1)
    const copyId = own[0]?.id ?? ""
    expect(own[0]?.copied_from_id).toBe(fileA)
    expect(saved.fileIdMap).toEqual({ [fileA]: copyId })
    expect(saved.notCopied ?? []).toEqual([])
    const expected = `Before ${tokenOf(copyId)} after ![alt kept](liaison-file:${copyId})\n\`${tokenOf(fileA)}\``
    expect(saved.body).toBe(expected)
    expect(await storedBody(b.id)).toBe(expected)
    expect(copies).toHaveLength(1)

    // The second save of the same text copies nothing.
    copies.length = 0
    const again = await save(editor, b.id, `${expected} more`)
    expect(again.fileIdMap ?? {}).toEqual({})
    expect(copies).toHaveLength(0)
    expect(await filesOf(b.id)).toHaveLength(1)

    // A pasted token of A again: the same copy, no second file.
    const pastedAgain = await save(editor, b.id, `${expected} ${tokenOf(fileA)}`)
    expect(pastedAgain.fileIdMap).toEqual({ [fileA]: copyId })
    expect(await filesOf(b.id)).toHaveLength(1)

    // Page A purged: B's readers still read B's file.
    await withPrivilegedDb(orgId, "test-purge", async (tx) => {
      await tx.execute(sql`DELETE FROM kernel.files WHERE id = ${fileA}::uuid`)
      await tx.execute(sql`DELETE FROM app_knowledge.documents WHERE id = ${a.id}::uuid`)
    })
    expect((await call(viewer, "GET", `/files/${copyId}/metadata`)).status).toBe(200)
  })

  it("by an agent's create and update", async () => {
    const a = await page(editor)
    const fileA = await fileOn(a.id)
    const fileA2 = await fileOn(a.id)
    const actor = knowledgeActorFromContext({
      orgId,
      userId: editor.userId,
      scopes: SCOPES,
      dimensionGrants: {},
      author: { type: "agent", agentId: null },
    })
    const created = await withRlsContext(rlsOf(editor), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Agent page",
          body: `Look ${tokenOf(fileA)}`,
          collectionIds: [],
          tagNames: [],
          team: [],
          verifyNow: false,
        } as never,
        actor,
        [],
      ),
    )
    const first = (await filesOf(created.id))[0]?.id ?? ""
    expect(first).not.toBe("")
    expect(await storedBody(created.id)).toBe(`Look ${tokenOf(first)}`)
    expect(created.body).toBe(`Look ${tokenOf(first)}`)

    const updated = await withRlsContext(rlsOf(editor), (tx) =>
      updateKnowledgeDocument(
        tx,
        {
          id: created.id,
          revision: created.revision,
          body: `Look ${tokenOf(first)} ${tokenOf(fileA2)}`,
        },
        actor,
        [],
      ),
    )
    const own = await filesOf(created.id)
    expect(own.map((f) => f.copied_from_id)).toEqual([fileA, fileA2])
    const second = own[1]?.id ?? ""
    expect(updated.body).toBe(`Look ${tokenOf(first)} ${tokenOf(second)}`)
    expect(updated.fileIdMap).toEqual({ [fileA2]: second })
  })

  it("a create that rolls back leaves no copy behind", async () => {
    const a = await page(editor)
    const fileA = await fileOn(a.id)
    let createdId = ""
    const actor = knowledgeActorFromContext({
      orgId,
      userId: editor.userId,
      scopes: SCOPES,
      dimensionGrants: {},
    })
    await expect(
      withRlsContext(rlsOf(editor), async (tx) => {
        const created = await createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Never kept",
            body: tokenOf(fileA),
            collectionIds: [],
            tagNames: [],
            team: [],
            verifyNow: false,
          } as never,
          actor,
          [],
        )
        createdId = created.id
        throw new Error("rolled back")
      }),
    ).rejects.toThrow("rolled back")
    expect(createdId).not.toBe("")
    // On a request login the copy's row commits on its own: nobody can read it (its
    // page does not exist), and the sweep removes it, never a copy of a live page.
    const live = await page(editor, { body: "" })
    await save(editor, live.id, tokenOf(fileA))
    const removed = await sweepUnparentedPageCopies({ graceMinutes: 0 })
    expect(removed).toBeGreaterThanOrEqual((await filesOf(createdId)).length)
    expect(await filesOf(createdId)).toEqual([])
    expect(await filesOf(live.id)).toHaveLength(1)
  })

  it("a file the writer cannot read is kept byte for byte and copied by nobody", async () => {
    const hidden = await page(editor, { orgAccess: "none" })
    const hiddenFile = await fileOn(hidden.id)
    const mine = await page(viewer, { body: "" })
    const text = `Pasted ${tokenOf(hiddenFile)} here`
    const saved = await save(viewer, mine.id, text)
    expect(saved.body).toBe(text)
    expect(await storedBody(mine.id)).toBe(text)
    expect(saved.notCopied).toEqual([{ id: hiddenFile, reason: "unavailable" }])
    expect(await filesOf(mine.id)).toEqual([])
    expect(copies).toHaveLength(0)
    // A reader of this page does not reach the other page's file.
    expect((await call(outsider, "GET", `/files/${hiddenFile}/metadata`)).status).toBe(404)
  })

  it("over the quota: the text is saved, the copy reported, and made at the next save", async () => {
    const a = await page(editor)
    const fileA = await fileOn(a.id)
    const b = await page(editor, { body: "" })
    const filler = await fileOn(a.id, { size: 2 * 1024 ** 3 })
    await withPrivilegedDb(orgId, "test-quota", (tx) =>
      tx.execute(
        sql`UPDATE kernel.organizations SET caps = COALESCE(caps, '{}'::jsonb) || '{"storageGb": 1}'::jsonb WHERE id = ${orgId}::uuid`,
      ),
    )
    try {
      const text = `Quota ${tokenOf(fileA)}`
      const saved = await save(editor, b.id, text)
      expect(saved.body).toBe(text)
      expect(saved.notCopied).toEqual([{ id: fileA, reason: "quota" }])
      expect(await filesOf(b.id)).toEqual([])

      await withPrivilegedDb(orgId, "test-quota-free", (tx) =>
        tx.execute(sql`DELETE FROM kernel.files WHERE id = ${filler}::uuid`),
      )
      const retried = await save(editor, b.id, `${text}.`)
      const own = await filesOf(b.id)
      expect(own).toHaveLength(1)
      expect(retried.body).toBe(`Quota ${tokenOf(own[0]?.id ?? "")}.`)
    } finally {
      await withPrivilegedDb(orgId, "test-quota-reset", (tx) =>
        tx.execute(
          sql`UPDATE kernel.organizations SET caps = COALESCE(caps, '{}'::jsonb) - 'storageGb' WHERE id = ${orgId}::uuid`,
        ),
      )
    }
  })
})

describe("a save copies only a page's file or a fresh upload", () => {
  it("never a template's file, a sealed file or another kind's file the writer can read", async () => {
    const scopes = [...SCOPES, "kernel:files:read"]
    const a = await page(editor)
    const sealed = await seedFileRow({
      orgId,
      app: "knowledge",
      entityType: "document",
      entityId: a.id,
      filename: "sealed.png",
      mimeType: "image/png",
      sizeBytes: 10,
      storageKey: `test/${randomUUID()}/sealed.png`,
      uploadedBy: editor.userId,
      encVersion: 1,
    })
    const [template] = await withPrivilegedDb(orgId, "test-template", (tx) =>
      tx
        .insert(documentTemplates)
        .values({ orgId, name: "Letter", kind: "rich_text", body: { type: "doc" } })
        .returning({ id: documentTemplates.id }),
    )
    const templateFile = await seedFileRow({
      orgId,
      app: "kernel",
      entityType: "document_template",
      entityId: template?.id ?? "",
      filename: "logo.png",
      mimeType: "image/png",
      sizeBytes: 10,
      storageKey: `test/${randomUUID()}/logo.png`,
      uploadedBy: editor.userId,
    })
    const b = await page(editor, { body: "" })
    const actor = knowledgeActorFromContext({
      orgId,
      userId: editor.userId,
      scopes,
      dimensionGrants: {},
    })
    const ctx = { ...rlsOf(editor), scopes }
    const result = await withRlsContext(ctx, async (tx) => {
      const session = await createUploadSession(
        {
          orgId,
          userId: editor.userId,
          scopes,
          targetApp: "knowledge",
          targetEntityType: "document",
          targetEntityId: null,
        },
        { rlsTx: tx, privileged },
      )
      const uploaded = await seedFileRow({
        orgId,
        app: "kernel",
        entityType: "file_upload_session",
        entityId: session.id,
        filename: "pasted.png",
        mimeType: "image/png",
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}/pasted.png`,
        uploadedBy: editor.userId,
      })
      // The writer reads all three: what keeps two of them is the kind of parent.
      const visible = extractRows<{ id: string }>(
        await tx.execute(sql`
          SELECT id::text AS id FROM kernel.files
           WHERE id = ANY(${`{${sealed},${templateFile},${uploaded}}`}::uuid[])`),
      )
      expect(visible.map((r) => r.id).sort()).toEqual([sealed, templateFile, uploaded].sort())
      const doc = await updateKnowledgeDocument(
        tx,
        {
          id: b.id,
          revision: b.revision,
          body: `${tokenOf(sealed)} ${tokenOf(templateFile)} ${tokenOf(uploaded)}`,
        },
        actor,
        [],
      )
      return { doc, uploaded }
    })
    const own = await filesOf(b.id)
    expect(own.map((f) => f.copied_from_id)).toEqual([result.uploaded])
    expect(result.doc.body).toBe(
      `${tokenOf(sealed)} ${tokenOf(templateFile)} ${tokenOf(own[0]?.id ?? "")}`,
    )
    expect(result.doc.notCopied).toEqual([
      { id: sealed, reason: "not_allowed" },
      { id: templateFile, reason: "not_allowed" },
    ])
  })
})

describe("the hourly sweep removes copies no saved text names", () => {
  it("a copy left by a failed save goes; one a text, a version or the page's creation holds stays", async () => {
    const a = await page(editor)
    const src = await Promise.all([1, 2, 3, 4, 5].map(() => fileOn(a.id)))
    const b = await page(editor, { body: "" })
    const actor = knowledgeActorFromContext({
      orgId,
      userId: editor.userId,
      scopes: SCOPES,
      dimensionGrants: {},
    })
    // A save that fails after its copy: on a request login the copy's row has committed.
    await expect(
      withRlsContext(rlsOf(editor), async (tx) => {
        await updateKnowledgeDocument(
          tx,
          { id: b.id, revision: b.revision, body: tokenOf(src[0] ?? "") },
          actor,
          [],
        )
        throw new Error("failed after the copy")
      }),
    ).rejects.toThrow("failed after the copy")
    // The same, as the privileged pool leaves it whatever this login can do.
    const stray = await seedFileRow({
      orgId,
      app: "knowledge",
      entityType: "document",
      entityId: b.id,
      filename: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 10,
      storageKey: `test/${randomUUID()}/diagram.png`,
      uploadedBy: editor.userId,
      copiedFromId: src[1] ?? "",
    })
    // Named by a version only (the text moved on), and named by the text.
    const first = await save(editor, b.id, tokenOf(src[2] ?? ""))
    const inVersion = (await filesOf(b.id)).find((f) => f.copied_from_id === src[2])?.id ?? ""
    expect(first.body).toBe(tokenOf(inVersion))
    const second = await save(editor, b.id, `moved on ${tokenOf(src[3] ?? "")}`)
    const inText = (await filesOf(b.id)).find((f) => f.copied_from_id === src[3])?.id ?? ""
    expect(second.body).toBe(`moved on ${tokenOf(inText)}`)
    // A file the import attached with the page (same transaction, same created_at).
    const [created] = extractRows<{ created_at: string }>(
      await withPrivilegedDb(orgId, "test-created", (tx) =>
        tx.execute(sql`SELECT created_at::text AS created_at FROM app_knowledge.documents
                        WHERE id = ${b.id}::uuid`),
      ),
    )
    const imported = await seedFileRow({
      orgId,
      app: "knowledge",
      entityType: "document",
      entityId: b.id,
      filename: "attached.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      storageKey: `test/${randomUUID()}/attached.pdf`,
      uploadedBy: editor.userId,
      copiedFromId: src[4] ?? "",
      createdAt: new Date(created?.created_at ?? ""),
    })
    await sweepUnparentedPageCopies({ graceMinutes: 0 })
    const left = (await filesOf(b.id)).map((f) => f.id)
    expect(left).not.toContain(stray)
    expect(left).toContain(inVersion)
    expect(left).toContain(inText)
    expect(left).toContain(imported)
    // Nothing of the failed save is left: only the kept copies.
    expect(left.sort()).toEqual([inVersion, inText, imported].sort())
  })
})

describe("agents keep tokens and see what they name", () => {
  it("knowledge_update then knowledge_get: the text round-trips byte for byte, files listed", async () => {
    const doc = await page(editor, { body: "" })
    const own = await fileOn(doc.id)
    const linked = randomUUID()
    const unknownFile = randomUUID()
    const text = [
      `# Title ${tokenOf(own)}`,
      `- item [](knowledge:document:${linked}) and ![](liaison-file:${unknownFile})`,
      `| a | ${tokenOf(own)} |`,
      "| - | - |",
      `> quote ${tokenOf(own)}`,
    ].join("\n")
    const bridge = (tx: unknown) =>
      createRpcBridge(
        "knowledge",
        editor.userId,
        orgId,
        tx as never,
        knowledgeManifest as never,
        SCOPES,
        "user",
        undefined,
        {
          callerApp: "calls",
          actor: {
            actorType: "user",
            userId: editor.userId,
            orgId,
            scopes: SCOPES,
            dimensionGrants: {},
          } as never,
        },
      ) as Record<string, (p: string) => Promise<string>>

    const fresh = await current(editor, doc.id)
    await withRlsContext(rlsOf(editor), (tx) =>
      bridge(tx).knowledge_update?.(
        JSON.stringify({ id: doc.id, revision: fresh.revision, body: text }),
      ),
    )
    expect(await storedBody(doc.id)).toBe(text)
    const got = JSON.parse(
      (await withRlsContext(rlsOf(editor), (tx) =>
        bridge(tx).knowledge_get?.(JSON.stringify({ id: doc.id })),
      )) ?? "{}",
    ) as {
      document: { body: string; files: Array<{ id: string; filename: string; mimeType: string }> }
    }
    expect(got.document.body).toBe(text)
    expect(got.document.files).toEqual([
      { id: own, filename: "diagram.png", mimeType: "image/png" },
    ])
  })

  it("the update tool tells agents to keep every token exactly", () => {
    const update = (knowledgeManifest as { tools: Record<string, { description: string }> }).tools
      .update?.description
    expect(update).toContain("keep every `![](liaison-file:")
    expect(update).toContain("`[](knowledge:document:")
  })
})
