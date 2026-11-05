// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import {
  externalOnlyDetail,
  getDetailExternalLink,
  resolveConnectionTemplateVars,
} from "~/modules/apps/detail-external-link"
import { listBacklinks } from "~/modules/threads/reference"

const backlinkQuerySchema = z.object({
  app: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

const openTargetQuerySchema = z.object({
  app: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
})

export const references = new Hono<AppEnv>()

/**
 * Resolve how a referenced entity should be OPENED from a thread mention or the
 * entity-preview popover. The frontend resolves in-app targets (tab types,
 * detail panels) synchronously from its own registry; it calls this endpoint
 * ONLY for entities that declare an EXTERNAL-ONLY detail view
 * (`views.detail.<entity>.externalLink` with no in-app component — e.g. a
 * Shopify order), because the deep link needs the org connection's shop domain
 * which lives server-side. Returns `{ kind: "external", url, label }` when a
 * link resolves, else `{ kind: "internal" }` so the caller falls back to its
 * own tab handling. Org-scoped via RLS.
 */
references.get("/open-target", zValidator("query", openTargetQuerySchema), async (c) => {
  const { app, entityType, entityId } = c.req.valid("query")
  const orgId = c.get("orgId")
  if (!externalOnlyDetail(orgId, app, entityType)) {
    return success(c, { kind: "internal" as const })
  }
  // App `connected_accounts` rows (the shop domain) are RLS-invisible, so the
  // template var is resolved via a privileged read scoped to the caller's org.
  const vars = await withPrivilegedDb(orgId, "open-target-connection-load", (ptx) =>
    resolveConnectionTemplateVars(ptx, orgId, app),
  )
  const ext = vars ? getDetailExternalLink(orgId, app, entityType, entityId, vars) : null
  return success(
    c,
    ext
      ? { kind: "external" as const, url: ext.url, label: ext.label }
      : { kind: "internal" as const },
  )
})

references.get("/", zValidator("query", backlinkQuerySchema), async (c) => {
  const { app, entityType, entityId, limit, offset } = c.req.valid("query")
  const result = await withRequestRls(c, (tx) =>
    listBacklinks(tx, {
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      scopes: c.get("scopes") as unknown as string[],
      app,
      entityType,
      entityId,
      limit,
      offset,
    }),
  )
  return success(c, result)
})
