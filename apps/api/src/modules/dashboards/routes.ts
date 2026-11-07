// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/dashboards: a person's own and the org's dashboards (service.ts), and a
// block's data for the person viewing it. A person's call is decided by their
// scopes, never by an approval (the agent's tools add one for org dashboards).

import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRlsContext } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { getRequestSignal } from "~/middleware/request-timeout"
import {
  createDashboard,
  DashboardError,
  deleteDashboard,
  getBlockData,
  getDashboard,
  listDashboards,
  updateDashboard,
} from "~/modules/dashboards/service"

export const dashboardsRoutes = new Hono<AppEnv>()

const idParam = z.object({ id: z.string().uuid() })
const blockParam = z.object({ id: z.string().uuid(), blockId: z.string().min(1).max(40) })
const title = z.string().trim().min(1).max(200)
const visibility = z.enum(["personal", "org"])

const createBody = z.object({
  title,
  visibility: visibility.default("personal"),
  spec: z.unknown(),
})
const updateBody = z
  .object({
    title: title.optional(),
    visibility: visibility.optional(),
    spec: z.unknown().optional(),
    ifVersion: z.number().int().min(1).optional(),
  })
  .refine((b) => b.title !== undefined || b.visibility !== undefined || b.spec !== undefined, {
    message: "nothing to change",
  })

const STATUS = {
  NOT_FOUND: 404,
  SCOPE_DENIED: 403,
  INVALID_SPEC: 422,
  VERSION_CONFLICT: 409,
} as const

function failure(c: Context<AppEnv>, err: unknown) {
  if (err instanceof DashboardError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.problems.length ? `${err.message}: ${err.problems.join("; ")}` : err.message,
          ...(err.problems.length ? { problems: err.problems } : {}),
        },
      },
      STATUS[err.code],
    )
  }
  throw err as Error
}

dashboardsRoutes
  .get("/", async (c) => {
    try {
      return success(c, await listDashboards(extractRlsContext(c)))
    } catch (err) {
      return failure(c, err)
    }
  })
  .post("/", zValidator("json", createBody), async (c) => {
    const body = c.req.valid("json")
    try {
      const row = await createDashboard(extractRlsContext(c), body)
      return success(c, row, undefined, 201)
    } catch (err) {
      return failure(c, err)
    }
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    try {
      return success(c, await getDashboard(extractRlsContext(c), c.req.valid("param").id))
    } catch (err) {
      return failure(c, err)
    }
  })
  .patch("/:id", zValidator("param", idParam), zValidator("json", updateBody), async (c) => {
    try {
      const row = await updateDashboard(
        extractRlsContext(c),
        c.req.valid("param").id,
        c.req.valid("json"),
      )
      return success(c, row)
    } catch (err) {
      return failure(c, err)
    }
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    try {
      await deleteDashboard(extractRlsContext(c), c.req.valid("param").id)
      return success(c, { deleted: true })
    } catch (err) {
      return failure(c, err)
    }
  })
  // One block's data, run as the viewer. A block's own refusal (no_access, not_allowed,
  // a failed source, a refresh refused as `rate_limited`) is a 200 with `{error, message}`,
  // so the other blocks render: a real 429 would pause every read of the web shell.
  .get("/:id/blocks/:blockId/data", zValidator("param", blockParam), async (c) => {
    const { id, blockId } = c.req.valid("param")
    const refresh = c.req.query("refresh") === "1"
    try {
      const out = await getBlockData(extractRlsContext(c), id, blockId, {
        refresh,
        signal: getRequestSignal(c),
      })
      // The chart's data at the top level (`kind`, ...), or the block's refusal `{error, message}`.
      return success(
        c,
        out.ok
          ? { ...out.data, blockId, cached: out.cached, computedAt: out.computedAt }
          : { blockId, error: out.error, message: out.message },
      )
    } catch (err) {
      return failure(c, err)
    }
  })
