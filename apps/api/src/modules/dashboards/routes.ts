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
import { editOperationSchema, MAX_CARD_CHANGES } from "~/modules/dashboards/edit"
import {
  blockDataCsv,
  computeDashboard,
  exportFilename,
  renderDashboardPdf,
  rowsCsv,
} from "~/modules/dashboards/export"
import { COMPARE_MODES, TIME_PRESETS } from "~/modules/dashboards/relative-dates"
import {
  clearViewerRange,
  createDashboard,
  DashboardError,
  DRILL_EXPORT_LIMIT,
  deleteDashboard,
  duplicateDashboard,
  editDashboard,
  getBlockData,
  getBlockRows,
  getDashboard,
  getFilterOptions,
  getVersion,
  getViewerRange,
  listDashboards,
  listVersions,
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

/** A person's edit: the same ordered operations as the agent's dashboards_edit. */
const editBody = z.object({
  ifVersion: z.number().int().min(1),
  operations: z.array(editOperationSchema).min(1).max(MAX_CARD_CHANGES),
})
const duplicateBody = z.object({ title: title.optional() })
const versionParam = z.object({
  id: z.string().uuid(),
  version: z
    .string()
    .regex(/^\d{1,9}$/, "a version number")
    .transform(Number),
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

const filterValuesBody = z.record(z.string().max(40), z.array(z.string().max(200)).max(50))
const viewerStateBody = z
  .object({
    timeRange: timeRangeSchema.optional(),
    compare: z.enum(COMPARE_MODES).optional(),
    filters: filterValuesBody.optional(),
  })
  .refine((b) => b.timeRange !== undefined || b.compare !== undefined || b.filters !== undefined, {
    message: "nothing to remember",
  })

/** The range part of a query (`range`, `from`/`to`), checked, as a TimeRange or undefined. */
const rangeQuery = z
  .object({
    range: z.enum(TIME_PRESETS).optional(),
    from: day.optional(),
    to: day.optional(),
  })
  .passthrough()
  .transform((q, ctx) => {
    const custom = q.range === "custom" || (q.range === undefined && (q.from || q.to))
    if (!custom && (q.from || q.to)) {
      ctx.addIssue({ code: "custom", message: "from and to go with range=custom only" })
      return z.NEVER
    }
    if (!custom && !q.range) return { timeRange: undefined }
    const parsed = timeRangeSchema.safeParse(
      custom ? { preset: "custom", from: q.from, to: q.to } : { preset: q.range },
    )
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: "custom", message: issue.message })
      return z.NEVER
    }
    return { timeRange: parsed.data }
  })

/** Filter values from `f.<id>=value` query params (repeated for a multi filter). */
function filterValuesOf(c: Context<AppEnv>): Record<string, string[]> | undefined {
  const all = c.req.queries()
  let out: Record<string, string[]> | undefined
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("f.")) continue
    out ??= {}
    out[k.slice(2)] = v
  }
  return out
}

const intParam = z
  .string()
  .regex(/^\d{1,5}$/, "a whole number")
  .transform(Number)

const rowsQuery = z
  .object({
    category: z.string().max(200).optional(),
    series: z.string().max(200).optional(),
    row: intParam.optional(),
    offset: intParam.optional(),
    limit: intParam.optional(),
  })
  .passthrough()

const optionsQuery = z.object({ q: z.string().max(100).optional() }).passthrough()
const filterParam = z.object({ id: z.string().uuid(), filterId: z.string().min(1).max(40) })

const STATUS = {
  NOT_FOUND: 404,
  SCOPE_DENIED: 403,
  INVALID_SPEC: 422,
  VERSION_CONFLICT: 409,
  INVALID_REQUEST: 400,
} as const

/** A file answer: the bytes, their type, and a download name. */
function download(c: Context<AppEnv>, body: string | Uint8Array, type: string, filename: string) {
  return c.body(typeof body === "string" ? body : (body as Uint8Array<ArrayBuffer>), 200, {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  })
}

/** A block that cannot export (no_access, rate_limited, ...): 422 naming its reason. */
function blockRefused(c: Context<AppEnv>, error: string, message: string) {
  return c.json({ error: { code: error, message } }, 422)
}

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
  // A person's edit by operations (reorder, resize, rename, duplicate, remove, revert...):
  // their scopes decide, never an approval. Answers the dashboard as GET /:id does.
  .post("/:id/edit", zValidator("param", idParam), zValidator("json", editBody), async (c) => {
    const viewer = extractRlsContext(c)
    const { id } = c.req.valid("param")
    try {
      await editDashboard(viewer, id, c.req.valid("json"))
      return success(c, await getDashboard(viewer, id))
    } catch (err) {
      return failure(c, err)
    }
  })
  // A copy as the caller's own personal dashboard.
  .post(
    "/:id/duplicate",
    zValidator("param", idParam),
    zValidator("json", duplicateBody),
    async (c) => {
      try {
        const row = await duplicateDashboard(
          extractRlsContext(c),
          c.req.valid("param").id,
          c.req.valid("json"),
        )
        return success(c, row, undefined, 201)
      } catch (err) {
        return failure(c, err)
      }
    },
  )
  .get("/:id/versions", zValidator("param", idParam), async (c) => {
    try {
      const versions = await listVersions(extractRlsContext(c), c.req.valid("param").id)
      return success(c, { versions })
    } catch (err) {
      return failure(c, err)
    }
  })
  .get("/:id/versions/:version", zValidator("param", versionParam), async (c) => {
    const { id, version } = c.req.valid("param")
    try {
      return success(c, await getVersion(extractRlsContext(c), id, version))
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
        const filters = filterValuesOf(c)
        const out = await getBlockData(extractRlsContext(c), id, blockId, {
          refresh: q.refresh,
          signal: getRequestSignal(c),
          ...(filters ? { filters } : {}),
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
  // The block's figures as CSV (what the chart draws), same query as the data.
  .get(
    "/:id/blocks/:blockId/data.csv",
    zValidator("param", blockParam),
    zValidator("query", blockDataQuery),
    async (c) => {
      const { id, blockId } = c.req.valid("param")
      const q = c.req.valid("query")
      const viewer = extractRlsContext(c)
      try {
        const filters = filterValuesOf(c)
        const out = await getBlockData(viewer, id, blockId, {
          signal: getRequestSignal(c),
          ...(filters ? { filters } : {}),
          ...(q.timeRange ? { range: q.timeRange } : {}),
          ...(q.compare ? { compare: q.compare } : {}),
        })
        if (!out.ok) return blockRefused(c, out.error, out.message)
        if (out.data.kind === "text") {
          return c.json(
            { error: { code: "INVALID_REQUEST", message: "a text block has no data" } },
            400,
          )
        }
        const view = await getDashboard(viewer, id)
        const title = view.spec.blocks.find((b) => b.id === blockId)?.title ?? blockId
        return download(
          c,
          blockDataCsv(title, out.data),
          "text/csv; charset=utf-8",
          exportFilename(title, "csv"),
        )
      } catch (err) {
        return failure(c, err)
      }
    },
  )
  // The rows behind a block (or one of its figures) as CSV: every row, up to the rows read.
  .get(
    "/:id/blocks/:blockId/rows.csv",
    zValidator("param", blockParam),
    zValidator("query", rowsQuery),
    async (c) => {
      const { id, blockId } = c.req.valid("param")
      const q = c.req.valid("query")
      const range = rangeQuery.safeParse(c.req.query())
      if (!range.success) {
        return c.json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: range.error.issues[0]?.message ?? "bad range",
            },
          },
          400,
        )
      }
      const viewer = extractRlsContext(c)
      try {
        const filters = filterValuesOf(c)
        const out = await getBlockRows(viewer, id, blockId, {
          signal: getRequestSignal(c),
          ...(range.data.timeRange ? { range: range.data.timeRange } : {}),
          ...(filters ? { filters } : {}),
          ...(q.category !== undefined ? { category: q.category } : {}),
          ...(q.series !== undefined ? { series: q.series } : {}),
          ...(q.row !== undefined ? { row: q.row } : {}),
          offset: 0,
          limit: DRILL_EXPORT_LIMIT,
          exportAll: true,
        })
        if (!out.ok) return blockRefused(c, out.error, out.message)
        return download(
          c,
          rowsCsv(out.columns, out.rows),
          "text/csv; charset=utf-8",
          exportFilename(`${blockId}-rows`, "csv"),
        )
      } catch (err) {
        return failure(c, err)
      }
    },
  )
  // The whole dashboard as a PDF, for the range and filters in the query (else the defaults).
  .get("/:id/export.pdf", zValidator("param", idParam), async (c) => {
    const parsed = blockDataQuery.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: parsed.error.issues[0]?.message ?? "bad range",
          },
        },
        400,
      )
    }
    const q = parsed.data
    const { id } = c.req.valid("param")
    try {
      const filters = filterValuesOf(c)
      const computed = await computeDashboard(extractRlsContext(c), id, {
        signal: getRequestSignal(c),
        ...(filters ? { filters } : {}),
        ...(q.timeRange ? { range: q.timeRange } : {}),
        ...(q.compare ? { compare: q.compare } : {}),
      })
      const bytes = await renderDashboardPdf(computed, filters)
      return download(c, bytes, "application/pdf", exportFilename(computed.view.title, "pdf"))
    } catch (err) {
      return failure(c, err)
    }
  })
  // The rows behind one figure of a block (a bar, a slice, a table row, a metric), read-only,
  // from the same cached read as its data; refusals as for the data route.
  .get(
    "/:id/blocks/:blockId/rows",
    zValidator("param", blockParam),
    zValidator("query", rowsQuery),
    async (c) => {
      const { id, blockId } = c.req.valid("param")
      const q = c.req.valid("query")
      const range = rangeQuery.safeParse(c.req.query())
      if (!range.success) {
        return c.json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: range.error.issues[0]?.message ?? "bad range",
            },
          },
          400,
        )
      }
      try {
        const filters = filterValuesOf(c)
        const out = await getBlockRows(extractRlsContext(c), id, blockId, {
          signal: getRequestSignal(c),
          ...(range.data.timeRange ? { range: range.data.timeRange } : {}),
          ...(filters ? { filters } : {}),
          ...(q.category !== undefined ? { category: q.category } : {}),
          ...(q.series !== undefined ? { series: q.series } : {}),
          ...(q.row !== undefined ? { row: q.row } : {}),
          ...(q.offset !== undefined ? { offset: q.offset } : {}),
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
        })
        if (!out.ok) {
          const { ok: _ok, ...refusal } = out
          return success(c, refusal)
        }
        const { ok: _ok, ...rows } = out
        return success(c, rows)
      } catch (err) {
        return failure(c, err)
      }
    },
  )
  // A filter's options (its static list, or the distinct values of a field of its source).
  .get(
    "/:id/filters/:filterId/options",
    zValidator("param", filterParam),
    zValidator("query", optionsQuery),
    async (c) => {
      const { id, filterId } = c.req.valid("param")
      const range = rangeQuery.safeParse(c.req.query())
      if (!range.success) {
        return c.json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: range.error.issues[0]?.message ?? "bad range",
            },
          },
          400,
        )
      }
      try {
        const filters = filterValuesOf(c)
        const q = c.req.valid("query").q
        const out = await getFilterOptions(extractRlsContext(c), id, filterId, {
          signal: getRequestSignal(c),
          ...(range.data.timeRange ? { range: range.data.timeRange } : {}),
          ...(filters ? { filters } : {}),
          ...(q ? { q } : {}),
        })
        const { ok: _ok, ...rest } = out
        return success(c, rest)
      } catch (err) {
        return failure(c, err)
      }
    },
  )
