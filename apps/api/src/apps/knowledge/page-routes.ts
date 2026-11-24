// SPDX-License-Identifier: FSL-1.1-ALv2
import { knowledgeMoveDocumentSchema, normalizePageRefs } from "@liaison/shared"
import type { Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { moveDocument } from "~/apps/knowledge/move"
import {
  assertCanWriteDocumentRow,
  type KnowledgeActor,
  type KnowledgeDocumentRow,
  KnowledgeError,
  loadDocumentShareRole,
  loadKnowledgeDocument,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { getVersion, listVersions, saveUnapplied } from "~/apps/knowledge/versions"
import type { RlsClient } from "~/db"
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

export function mountPageRoutes(routes: Hono<AppEnv>, helpers: PageRouteHelpers): void {
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
          return saveUnapplied(tx, {
            orgId: actor.orgId,
            documentId: id,
            title: input.title,
            body: input.body,
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
