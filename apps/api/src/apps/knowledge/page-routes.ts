// SPDX-License-Identifier: FSL-1.1-ALv2
import { knowledgeMoveDocumentSchema, normalizePageRefs } from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { ensureIndexDocument, readFolderPage } from "~/apps/knowledge/folder-pages"
import { MAX_RESOLVE_IDS, pageBacklinks, pickPages, readablePages } from "~/apps/knowledge/links"
import { moveDocument } from "~/apps/knowledge/move"
import {
  assertCanReadDocumentRow,
  assertCanWriteDocumentRow,
  type KnowledgeActor,
  type KnowledgeDocumentRow,
  KnowledgeError,
  loadDocumentShareRole,
  loadKnowledgeDocument,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { getVersion, listVersions, saveUnapplied } from "~/apps/knowledge/versions"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"

/** What routes.ts shares with the routes mounted here (it imports this file). */
export interface PageRouteHelpers {
  getActor(c: Context<AppEnv>): KnowledgeActor
  /** A refused write on a page: 403 without the folder scope, else the zero-knowledge 404. */
  pageWriteRefusal(c: Context<AppEnv>, err: unknown): Response
  /** A refused read: the same 404 as an unknown id, naming nothing. */
  pageNotFound(c: Context<AppEnv>, err: unknown): Response
  /** A refused write on a folder: 403 without the scope it needs, else the zero-knowledge 404. */
  folderWriteRefusal(c: Context<AppEnv>, err: unknown): Response
}

const idParamSchema = z.object({ id: z.uuid() })
const versionParamSchema = z.object({ id: z.uuid(), vid: z.uuid() })
const restoreSchema = z.object({ revision: z.number().int().nonnegative() })
/** A text that could not be saved (a conflict left open, another tab's draft). */
const unappliedSchema = z.object({
  title: z.string().max(240),
  body: z.string().max(1_000_000),
  baseRevision: z.number().int().nonnegative(),
  session: z.uuid().nullable().optional(),
})

const resolveSchema = z.object({ ids: z.array(z.uuid()).max(MAX_RESOLVE_IDS) })
const pickQuerySchema = z.object({ q: z.string().max(200).optional() })
/** The first text of a folder's page, written when the page is made. */
const folderPageStartSchema = z.object({ body: z.string().max(1_000_000).optional() }).strict()

const notFound = () => new KnowledgeError("NOT_FOUND", "Knowledge item not found")

/**
 * The page, when the actor may edit it: history is the edit right's (edge 12), and a
 * synced page has none (edge 6). Anything else is the same not-found as an unknown id.
 */
async function editablePage(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow> {
  const row = await loadKnowledgeDocument(tx, id, actor)
  if (!row || row.syncedSourceId) throw notFound()
  assertCanWriteDocumentRow(row, actor, await loadDocumentShareRole(tx, row.id, actor))
  return row
}

/**
 * Stored history may hold a page link with its title (`@[Title](knowledge:document:id)`
 * as agents wrote them): it leaves the server without the title, which the reader may
 * not be allowed to see. The rows themselves stay as written.
 */
function withoutLinkTitles<T extends { title: string; body?: string }>(v: T): T {
  return {
    ...v,
    title: normalizePageRefs(v.title),
    ...(v.body !== undefined ? { body: normalizePageRefs(v.body) } : {}),
  }
}

/** The autosave query of PATCH /documents/:id, read by routes.ts. */
export function autosaveOptions(query: (name: string) => string | undefined) {
  if (query("autosave") !== "1") return null
  const session = z.uuid().safeParse(query("session"))
  return {
    coalesceEvents: true,
    session: { id: session.success ? session.data : null, fresh: query("fresh") === "1" },
  }
}

/** The page, when the actor may read it; anything else is the not-found of an unknown id. */
async function readablePage(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeDocumentRow> {
  const row = await loadKnowledgeDocument(tx, id, actor)
  if (!row) throw notFound()
  assertCanReadDocumentRow(row, actor, await loadDocumentShareRole(tx, row.id, actor))
  return row
}

/**
 * The conversations that reference a page (`kernel.thread_references`, under the
 * reader's row security, so only threads the reader can see). Private assistant chats
 * (`agent_chat`) are never listed: they collect references for the assistant's own use.
 */
async function threadBacklinks(tx: RlsClient, orgId: string, id: string) {
  const K = sql.raw(schemaRef("kernel"))
  const rows = extractRows<{ threadId: string; title: string | null }>(
    await tx.execute(sql`
      SELECT tr.thread_id AS "threadId", t.title AS "title"
        FROM ${K}.thread_references tr
        JOIN ${K}.threads t ON t.id = tr.thread_id
       WHERE tr.app = 'knowledge' AND tr.entity_type = 'document'
         AND tr.entity_id = ${id} AND tr.org_id = ${orgId}::uuid
         AND t.type <> 'agent_chat'
       ORDER BY tr.last_visited_at DESC
       LIMIT 100`),
  )
  return rows.map((r) => ({
    kind: "thread" as const,
    app: "kernel",
    entityType: "thread",
    entityId: r.threadId,
    title: r.title ?? "Thread",
    url: `/threads/${r.threadId}`,
  }))
}

export function mountPageRoutes(routes: Hono<AppEnv>, helpers: PageRouteHelpers): void {
  // A folder's page and what is inside that the reader may open (folder-pages.ts).
  routes.get("/collections/:id/page", zValidator("param", idParamSchema), async (c) => {
    try {
      const actor = helpers.getActor(c)
      const { id } = c.req.valid("param")
      const view = await withRequestRls(c, (tx) => readFolderPage(tx, id, actor))
      return success(c, view)
    } catch (err) {
      return helpers.pageNotFound(c, err)
    }
  })

  // The first edit of a folder's page: made now when the folder has none, else the
  // existing one (201 when made here, 200 otherwise).
  routes.post(
    "/collections/:id/page",
    zValidator("param", idParamSchema),
    zValidator("json", folderPageStartSchema),
    async (c) => {
      try {
        const actor = helpers.getActor(c)
        const { id } = c.req.valid("param")
        const { body } = c.req.valid("json")
        const { page, created } = await withRequestRls(c, (tx) =>
          ensureIndexDocument(tx, id, actor, body === undefined ? {} : { body }),
        )
        return success(c, page, undefined, created ? 201 : 200)
      } catch (err) {
        return helpers.folderWriteRefusal(c, err)
      }
    },
  )

  // Titles of the pages a text links to, for this reader: live pages they may read only;
  // any other id is absent from the answer (the reader then shows "Page you cannot open").
  routes.post("/documents/resolve", zValidator("json", resolveSchema), async (c) => {
    const actor = helpers.getActor(c)
    const { ids } = c.req.valid("json")
    const pages = await withRequestRls(c, (tx) => readablePages(tx, actor, ids))
    return success(c, pages)
  })

  // The link picker: pages whose title holds `q`, that the writer may read.
  routes.get("/documents/pick", zValidator("query", pickQuerySchema), async (c) => {
    const actor = helpers.getActor(c)
    const { q } = c.req.valid("query")
    const pages = await withRequestRls(c, (tx) => pickPages(tx, actor, q ?? ""))
    return success(c, pages)
  })

  // What links here: pages (only those the reader may read) and conversations (only
  // those the reader can see). Never a count or a title of anything else.
  routes.get("/documents/:id/backlinks", zValidator("param", idParamSchema), async (c) => {
    try {
      const actor = helpers.getActor(c)
      const { id } = c.req.valid("param")
      const backlinks = await withRequestRls(c, async (tx) => {
        await readablePage(tx, id, actor)
        const pages = (await pageBacklinks(tx, actor, id)).map((p) => ({
          kind: "page" as const,
          app: "knowledge",
          entityType: "document",
          entityId: p.id,
          title: p.title,
        }))
        return [...pages, ...(await threadBacklinks(tx, actor.orgId, id))]
      })
      return success(c, { backlinks })
    } catch (err) {
      return helpers.pageNotFound(c, err)
    }
  })

  routes.post(
    "/documents/:id/move",
    zValidator("param", idParamSchema),
    zValidator("json", knowledgeMoveDocumentSchema),
    async (c) => {
      try {
        const actor = helpers.getActor(c)
        const { id } = c.req.valid("param")
        const moved = await withRequestRls(c, (tx) =>
          moveDocument(tx, { documentId: id, ...c.req.valid("json") }, actor),
        )
        return success(c, moved)
      } catch (err) {
        return helpers.pageWriteRefusal(c, err)
      }
    },
  )

  routes.get("/documents/:id/versions", zValidator("param", idParamSchema), async (c) => {
    try {
      const actor = helpers.getActor(c)
      const { id } = c.req.valid("param")
      const list = await withRequestRls(c, async (tx) => {
        await editablePage(tx, id, actor)
        return listVersions(tx, id)
      })
      return success(c, list.map(withoutLinkTitles))
    } catch (err) {
      return helpers.pageNotFound(c, err)
    }
  })

  routes.get("/documents/:id/versions/:vid", zValidator("param", versionParamSchema), async (c) => {
    try {
      const actor = helpers.getActor(c)
      const { id, vid } = c.req.valid("param")
      const version = await withRequestRls(c, async (tx) => {
        await editablePage(tx, id, actor)
        return getVersion(tx, id, vid)
      })
      if (!version) throw notFound()
      const { requiredScopes: _scopes, ...shown } = version
      return success(c, withoutLinkTitles(shown))
    } catch (err) {
      return helpers.pageNotFound(c, err)
    }
  })

  // A restore is an ordinary update with the version's text (its own version, kind
  // `restore`); a verified page is marked for review when the text changes (edge 13).
  routes.post(
    "/documents/:id/versions/:vid/restore",
    zValidator("param", versionParamSchema),
    zValidator("json", restoreSchema),
    async (c) => {
      try {
        const actor = helpers.getActor(c)
        const { id, vid } = c.req.valid("param")
        const { revision } = c.req.valid("json")
        const doc = await withRequestRls(c, async (tx) => {
          await editablePage(tx, id, actor)
          const version = await getVersion(tx, id, vid)
          if (!version) throw notFound()
          // The text as stored, and the tag the text carried, unioned back.
          return updateKnowledgeDocument(
            tx,
            { id, revision, title: version.title, body: version.body },
            actor,
            version.requiredScopes,
            { restore: true },
          )
        })
        return success(c, doc)
      } catch (err) {
        return helpers.pageWriteRefusal(c, err)
      }
    },
  )

  routes.post(
    "/documents/:id/versions",
    zValidator("param", idParamSchema),
    zValidator("json", unappliedSchema),
    async (c) => {
      try {
        const actor = helpers.getActor(c)
        const { id } = c.req.valid("param")
        const input = c.req.valid("json")
        const versionId = await withRequestRls(c, async (tx) => {
          await editablePage(tx, id, actor)
          // Stored like any text of the page: page links without titles.
          return saveUnapplied(tx, {
            orgId: actor.orgId,
            documentId: id,
            title: normalizePageRefs(input.title),
            body: normalizePageRefs(input.body),
            baseRevision: input.baseRevision,
            session: input.session ?? null,
            authorId: actor.userId,
          })
        })
        return success(c, { id: versionId }, undefined, 201)
      } catch (err) {
        return helpers.pageWriteRefusal(c, err)
      }
    },
  )
}
