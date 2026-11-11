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
import { COMPARE_MODES, TIME_PRESETS } from "~/modules/dashboards/relative-dates"
import {
  clearViewerRange,
  createDashboard,
  DashboardError,
  deleteDashboard,
  getBlockData,
  getDashboard,
  getViewerRange,
  listDashboards,
  setViewerRange,
  updateDashboard,
} from "~/modules/dashboards/service"
import { timeRangeSchema } from "~/modules/dashboards/spec"

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

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day is YYYY-MM-DD")

/** The viewer's range on a block's data: `range` (a preset), `from`/`to` (custom), `compare`. */
const blockDataQuery = z
  .object({
    refresh: z.string().optional(),
    range: z.enum(TIME_PRESETS).optional(),
    from: day.optional(),
    to: day.optional(),
    compare: z.enum(COMPARE_MODES).optional(),
  })
  .transform((q, ctx) => {
    const custom = q.range === "custom" || (q.range === undefined && (q.from || q.to))
    if (!custom && (q.from || q.to)) {
      ctx.addIssue({ code: "custom", message: "from and to go with range=custom only" })
      return z.NEVER
    }
    let timeRange: z.infer<typeof timeRangeSchema> | undefined
    if (custom || q.range) {
      const parsed = timeRangeSchema.safeParse(
        custom ? { preset: "custom", from: q.from, to: q.to } : { preset: q.range },
      )
      if (!parsed.success) {
        for (const issue of parsed.error.issues)
          ctx.addIssue({ code: "custom", message: issue.message })
        return z.NEVER
      }
      timeRange = parsed.data
    }
    return { refresh: q.refresh === "1", timeRange, compare: q.compare }
  })

const viewerStateBody = z.object({ timeRange: timeRangeSchema, compare: z.enum(COMPARE_MODES) })

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
  // The time range this person last chose on this dashboard (theirs alone), and forgetting it.
  .get("/:id/viewer-state", zValidator("param", idParam), async (c) => {
    try {
      return success(c, await getViewerRange(extractRlsContext(c), c.req.valid("param").id))
    } catch (err) {
      return failure(c, err)
    }
  })
  .put(
    "/:id/viewer-state",
    zValidator("param", idParam),
    zValidator("json", viewerStateBody),
    async (c) => {
      try {
        return success(
          c,
          await setViewerRange(extractRlsContext(c), c.req.valid("param").id, c.req.valid("json")),
        )
      } catch (err) {
        return failure(c, err)
      }
    },
  )
  .delete("/:id/viewer-state", zValidator("param", idParam), async (c) => {
    try {
      await clearViewerRange(extractRlsContext(c), c.req.valid("param").id)
      return success(c, { cleared: true })
    } catch (err) {
      return failure(c, err)
    }
  })
  // One block's data, run as the viewer, for the range it shows (`range`/`from`/`to`, and
  // `compare`; absent: the dashboard's default). A block's own refusal (no_access,
  // not_allowed, a failed source, a refresh refused as `rate_limited`) is a 200 with
  // `{error, message}`, so the other blocks render: a real 429 would pause every read of the
  // web shell.
  .get(
    "/:id/blocks/:blockId/data",
    zValidator("param", blockParam),
    zValidator("query", blockDataQuery),
    async (c) => {
      const { id, blockId } = c.req.valid("param")
      const q = c.req.valid("query")
      try {
        const out = await getBlockData(extractRlsContext(c), id, blockId, {
          refresh: q.refresh,
          signal: getRequestSignal(c),
          ...(q.timeRange ? { range: q.timeRange } : {}),
          ...(q.compare ? { compare: q.compare } : {}),
        })
        // The chart's data at the top level (`kind`, ...), or the block's refusal `{error, message}`.
        return success(
          c,
          out.ok
            ? {
                ...out.data,
                blockId,
                cached: out.cached,
                computedAt: out.computedAt,
                window: out.window,
                compareWindow: out.compareWindow,
                ...(out.previousError ? { previousError: out.previousError } : {}),
              }
            : {
                blockId,
                error: out.error,
                message: out.message,
                ...(out.window
                  ? { window: out.window, compareWindow: out.compareWindow ?? null }
                  : {}),
              },
        )
      } catch (err) {
        return failure(c, err)
      }
    },
  )
