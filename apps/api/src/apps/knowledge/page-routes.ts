// SPDX-License-Identifier: FSL-1.1-ALv2
import { knowledgeMoveDocumentSchema } from "@liaison/shared"
import type { Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { moveDocument } from "~/apps/knowledge/move"
import type { KnowledgeActor } from "~/apps/knowledge/service"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"

/** What routes.ts shares with the routes mounted here (it imports this file). */
export interface PageRouteHelpers {
  getActor(c: Context<AppEnv>): KnowledgeActor
  /** A refused write on a page: 403 without the folder scope, else the zero-knowledge 404. */
  pageWriteRefusal(c: Context<AppEnv>, err: unknown): Response
}

const idParamSchema = z.object({ id: z.uuid() })

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
}
