// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's dashboard tools over kernel.dashboards: sources, preview_block,
// create, update, get, list, delete. Registered once per org from
// agent/tools/kernel-tools.ts. The kernel skill `build-dashboard`
// (agent/prompts/kernel/build-dashboard.md) teaches the loop: find a source,
// preview each block until its data is right, then save, then open.
//
// Approvals: an agent's write that results in or touches an ORG dashboard
// (create one, switch one to org, edit or delete an org one) is gated with
// kernel:dashboards:admin, and its card lists the title and each block with
// its source. A personal dashboard is a plain write. A person's own REST call
// is never gated: their scopes decide (service.ts). A block whose params carry date
// tokens ({{today-30d}}) shows them as written and the date each one is today.
//
// dashboards_edit changes a dashboard by an ordered list of operations (edit.ts), applied
// at once or not at all; on an org dashboard the whole list is ONE approval whose card
// numbers the operations, one plain line each (describeOperations).

import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { dashboards, userRoles } from "~/db/schema/kernel"
import { type ApprovalSummarizer, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import {
  cardLineCount,
  describeOperations,
  diffDashboards,
  type EditOperation,
  editOperationSchema,
  MAX_CARD_CHANGES,
  revertTargets,
  tooManyChangesMessage,
} from "~/modules/dashboards/edit"
import { computeBlock, dashboardTimezone } from "~/modules/dashboards/execute"
import {
  checkRecipients,
  computeDashboard,
  exportFilename,
  renderDashboardPdf,
  StorageFullError,
  snapshotOf,
  stagePdfForViewer,
} from "~/modules/dashboards/export"
import {
  FilterValueError,
  type FilterValues,
  normalizeFilterValues,
  resolveFilterTokens,
  resolveWhere,
} from "~/modules/dashboards/filters"
import {
  DateTokenError,
  type DayWindow,
  dateTokensIn,
  hasDateTokens,
  resolveDateTokens,
  resolveTimeRange,
} from "~/modules/dashboards/relative-dates"
import {
  checkEdit,
  createDashboard,
  DashboardError,
  deleteDashboard,
  editDashboard,
  getDashboard,
  listDashboards,
  listVersions,
  readVersions,
  updateDashboard,
} from "~/modules/dashboards/service"
import { listEligibleSources } from "~/modules/dashboards/sources"
import {
  blockRangeMode,
  blockSourceOf,
  type DashboardSpec,
  dashboardDefaultRange,
  dashboardSpecSchema,
  specIssues,
  timeRangeSchema,
} from "~/modules/dashboards/spec"

const READ = "kernel:dashboards:read"
const WRITE = "kernel:dashboards:write"
const ADMIN = "kernel:dashboards:admin"
const SINK = "kernel.dashboards"

interface HandlerCtx {
  userId: string
  orgId: string
  db: RlsClient
  scopes?: string[]
  dimensionGrants?: Record<string, string[]>
  agentExecutionThreadId?: string
  abortSignal?: AbortSignal
}

/**
 * The person a tool call reads and writes for, with their role ids: row policies read them (a
 * record shared with a role), so an agent's preview shows exactly what the person will see on
 * the saved dashboard, whose REST reads carry the roles of the session.
 */
async function viewerOf(
  ctx: Pick<HandlerCtx, "userId" | "orgId" | "scopes" | "dimensionGrants">,
): Promise<UserContext> {
  const held = await withPrivilegedDb(ctx.orgId, "dashboard-viewer-roles", (tx) =>
    tx
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, ctx.userId), eq(userRoles.orgId, ctx.orgId))),
  )
  return {
    actorType: "user",
    userId: ctx.userId,
    orgId: ctx.orgId,
    scopes: ctx.scopes ?? [],
    dimensionGrants: ctx.dimensionGrants ?? {},
    roles: held.map((r) => r.roleId),
  }
}

const STATUS = {
  NOT_FOUND: 404,
  SCOPE_DENIED: 403,
  INVALID_SPEC: 422,
  VERSION_CONFLICT: 409,
  INVALID_REQUEST: 400,
} as const

/** A service refusal as the tool's error, with every problem named. */
function asToolError(err: unknown) {
  if (!(err instanceof DashboardError)) throw err
  return {
    error: {
      code: err.code.toLowerCase(),
      message: err.problems.length ? `${err.message}: ${err.problems.join("; ")}` : err.message,
      retryable: err.code === "INVALID_SPEC" || err.code === "VERSION_CONFLICT",
      status: STATUS[err.code],
    },
  }
}

async function guarded<T>(fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (err) {
    return asToolError(err)
  }
}

/** The refusal of a request with more changes than one approval card lists. */
function tooManyChanges(count: number) {
  return {
    error: {
      code: "too_many_changes",
      message: tooManyChangesMessage(count),
      retryable: false,
      status: 422,
    },
  }
}

/** A saved dashboard as the card reads it (the summarizer's own transaction). */
async function cardRow(tx: Parameters<ApprovalSummarizer>[1]["tx"], id: unknown) {
  if (typeof id !== "string") return undefined
  const [row] = await tx
    .select({ title: dashboards.title, visibility: dashboards.visibility, spec: dashboards.spec })
    .from(dashboards)
    .where(eq(dashboards.id, id))
    .limit(1)
  return row
}

/** The visibility of a saved dashboard, read for the gate (which runs before the handler). */
async function storedVisibility(orgId: string, id: unknown): Promise<"personal" | "org" | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null
  const [row] = await withPrivilegedDb(orgId, "dashboard-gate", (tx) =>
    tx
      .select({ visibility: dashboards.visibility })
      .from(dashboards)
      .where(eq(dashboards.id, id))
      .limit(1),
  )
  return row?.visibility ?? null
}

const visibilityParam = z
  .enum(["personal", "org"])
  .describe(
    "personal: only you see it (no approval). org: everyone in the organisation (a person approves).",
  )

const specParam = z
  .object({
    v: z.literal(1),
    layout: z.literal("grid").optional(),
    timeRange: z.record(z.string(), z.unknown()).optional(),
    compare: z.string().optional(),
    datasets: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    filters: z.array(z.record(z.string(), z.unknown())).max(8).optional(),
    blocks: z.array(z.record(z.string(), z.unknown())).max(24),
  })
  .describe(
    "The dashboard spec: {v:1, timeRange?, compare?, datasets?, filters?, blocks:[{id, type, title, width, source | dataset, map, text?, refreshSec?, timeRange?}]}, at most 24 blocks. kernel__skill_read build-dashboard for one worked block per chart type, shared datasets, filters and the dashboard time range.",
  )

/** The days a spec's default range covers today (what {{range.*}} mean on the card). */
function defaultWindow(spec: unknown, timeZone: string): DayWindow {
  const raw = (spec ?? {}) as { timeRange?: unknown; compare?: unknown }
  const parsed = timeRangeSchema.safeParse(raw.timeRange)
  const tr = dashboardDefaultRange(parsed.success ? { timeRange: parsed.data } : {}).timeRange
  return resolveTimeRange(tr, { timeZone, now: new Date() })
}

/** A block's date tokens with what each is today: `{{today-30d}} = 2026-10-11`. */
function tokenDates(source: Record<string, unknown>, timeZone: string, range: DayWindow): string {
  const value = source.kind === "store" ? source.query : source.params
  const now = new Date()
  return dateTokensIn(value)
    .slice(0, 4)
    .map((token) => {
      try {
        const date = resolveDateTokens(token, { timeZone, now, range })
        return token.startsWith("{{range.")
          ? `${token} = ${date} (the dashboard range by default)`
          : `${token} = ${date}`
      } catch (err) {
        if (err instanceof DateTokenError) return `${token} (not a date token)`
        throw err
      }
    })
    .join(", ")
}

/** The zone a card's token dates are shown in: the org's, looked up only when a block has tokens. */
async function cardTimezone(spec: unknown, orgId: string): Promise<string> {
  const s = spec as { blocks?: unknown; datasets?: unknown } | null
  return hasDateTokens([s?.blocks, s?.datasets]) ? dashboardTimezone(orgId) : "UTC"
}

/** One block's lines for an approval card: what it draws and from where. */
function blockLines(spec: unknown, timeZone: string, max = 6): string[] {
  const blocks = Array.isArray((spec as { blocks?: unknown })?.blocks)
    ? ((spec as { blocks: unknown[] }).blocks as Record<string, unknown>[])
    : []
  const range = defaultWindow(spec, timeZone)
  const datasets = ((spec as { datasets?: unknown })?.datasets ?? {}) as Record<string, unknown>
  const lines = blocks.slice(0, max).map((b) => {
    if (b.type === "text") return `text note "${String(b.title ?? b.id ?? "")}"`
    const shared = typeof b.dataset === "string" ? datasets[b.dataset] : undefined
    const source = (b.source ?? shared ?? {}) as Record<string, unknown>
    const from =
      source.kind === "store"
        ? `store ${String(source.app)}/${String(source.collection)}`
        : String(source.tool ?? "(no source)")
    const dates = tokenDates(source, timeZone, range)
    const via = typeof b.dataset === "string" ? ` (shared dataset '${b.dataset}')` : ""
    return `${String(b.type ?? "block")} "${String(b.title ?? b.id ?? "")}" from ${from}${via}${dates ? `, dates ${dates} (today, rolling)` : ""}`
  })
  if (blocks.length > max) lines.push(`and ${blocks.length - max} more blocks`)
  if (blocks.length === 0) lines.push("No blocks.")
  return lines
}

/** A new dashboard's spec as operations from an empty one: datasets, filters, then blocks. */
function createOperations(spec: unknown): EditOperation[] {
  return diffDashboards(EMPTY_DASHBOARD, { spec })
}
const EMPTY_DASHBOARD = {
  title: "",
  visibility: "personal" as const,
  spec: { v: 1, blocks: [] } as unknown as DashboardSpec,
}

// A create parks for an org dashboard, and also for a personal one when the turn's taint parks it
// (scope-taint rule 8b): the card says which, from the visibility the call carries, then lists the
// dashboard as dashboards_edit's card lists changes, one numbered line per dataset, filter and
// block (sources, params, date tokens, every note's full text and links).
const summarizeCreate: ApprovalSummarizer = async (raw, ctx) => {
  const p = (raw ?? {}) as { title?: string; spec?: unknown; visibility?: string }
  const ops = createOperations(p.spec)
  const lines = ops.length
    ? describeOperations(EMPTY_DASHBOARD, ops, {
        timeZone: await cardTimezone(p.spec, ctx.orgId),
        now: new Date(),
      })
    : ["No blocks."]
  if (p.visibility !== "org") {
    return {
      kind: "dashboard_create",
      title: `Save the personal dashboard "${p.title ?? ""}"`,
      subtitle: "Only its author will see it.",
      lines,
    }
  }
  return {
    kind: "dashboard_create",
    title: `Share the dashboard "${p.title ?? ""}" with the organisation`,
    subtitle: "Everyone in the organisation will see it, each with their own access.",
    lines,
  }
}

/**
 * A whole-spec save of an org dashboard, listed change by change as dashboards_edit's card
 * does: the stored dashboard and the new spec diffed into operations (title, visibility,
 * default range and comparison, each block removed, changed, added or moved), one plain
 * line each. Computed once when the approval is created.
 */
const summarizeUpdate: ApprovalSummarizer = async (raw, ctx) => {
  const p = (raw ?? {}) as { id?: string; title?: string; spec?: unknown; visibility?: string }
  const current = await cardRow(ctx.tx, p.id)
  const title = current?.title ?? p.title ?? ""
  if (!current) {
    return {
      kind: "dashboard_update",
      title: `Change the org dashboard "${title}"`,
      lines: [
        "The dashboard could not be read: approving applies the call as sent, or refuses it.",
      ],
    }
  }
  const stored = {
    title: current.title,
    visibility: current.visibility,
    spec: current.spec as unknown as DashboardSpec,
  }
  const ops = diffDashboards(stored, {
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.visibility === "org" || p.visibility === "personal" ? { visibility: p.visibility } : {}),
    ...(p.spec !== undefined ? { spec: p.spec } : {}),
  })
  const lines = ops.length
    ? describeOperations(stored, ops, {
        timeZone: await dashboardTimezone(ctx.orgId),
        now: new Date(),
      })
    : ["No change: the dashboard stays as it is."]
  const n = ops.length
  const sharing = current.visibility === "personal"
  return {
    kind: "dashboard_update",
    title: `${sharing ? "Share the dashboard" : "Change the org dashboard"} "${title}": ${n} change${n === 1 ? "" : "s"}`,
    subtitle: sharing
      ? "Everyone in the organisation will see this dashboard. All changes apply together."
      : "Everyone in the organisation sees this dashboard. All changes apply together.",
    lines,
  }
}

/**
 * The pooled card of one dashboards_edit call: one numbered line per operation, as they apply
 * in order to the dashboard read now (titles, positions, sources, date tokens and what they
 * mean today). A deterministic function of the call and the saved dashboard, computed once
 * when the approval is created.
 */
const summarizeEdit: ApprovalSummarizer = async (raw, ctx) => {
  const p = (raw ?? {}) as { dashboardId?: string; operations?: unknown }
  const ops = z.array(editOperationSchema).safeParse(p.operations)
  const current = await cardRow(ctx.tx, p.dashboardId)
  const title = current?.title ?? p.dashboardId ?? ""
  if (!ops.success || !current) {
    return {
      kind: "dashboard_edit",
      title: `Change the org dashboard "${title}"`,
      lines: ["The changes could not be read: approving applies them as sent, or refuses them."],
    }
  }
  const targets = revertTargets(ops.data)
  const versions =
    targets.length && typeof p.dashboardId === "string"
      ? await readVersions(ctx.tx, p.dashboardId, targets)
      : new Map()
  const lines = describeOperations(
    {
      title: current.title,
      visibility: current.visibility,
      spec: current.spec as unknown as DashboardSpec,
    },
    ops.data,
    { timeZone: await dashboardTimezone(ctx.orgId), now: new Date(), versions },
  )
  const n = ops.data.length
  // A personal dashboard's edit is gated by its own setVisibility org: it is being shared.
  const sharing = current.visibility === "personal"
  return {
    kind: "dashboard_edit",
    title: `${sharing ? "Share the dashboard" : "Change the org dashboard"} "${title}": ${n} change${n === 1 ? "" : "s"}`,
    subtitle: sharing
      ? "Everyone in the organisation will see this dashboard. All changes apply together."
      : "Everyone in the organisation sees this dashboard. All changes apply together.",
    lines,
  }
}

const summarizeDelete: ApprovalSummarizer = async (raw, ctx) => {
  const id = (raw as { id?: string } | null)?.id
  const [current] =
    typeof id === "string"
      ? await ctx.tx
          .select({ title: dashboards.title, spec: dashboards.spec })
          .from(dashboards)
          .where(eq(dashboards.id, id))
          .limit(1)
      : []
  return {
    kind: "dashboard_delete",
    title: `Delete the org dashboard "${current?.title ?? id ?? ""}"`,
    lines: [
      "Nobody in the organisation will see it any more.",
      ...blockLines(current?.spec, await cardTimezone(current?.spec, ctx.orgId), 5),
    ],
  }
}

/** Registers the kernel's dashboard tools for `orgId`. */
export function registerDashboardTools(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "dashboards_sources"], {
    appName: "kernel",
    name: "dashboards_sources",
    readOnly: true,
    deferLoading: true,
    description:
      "List the read tools you can put on a dashboard (each block reads one), with their params and the fields of their result when declared. Pass words of what to show (orders, tickets, revenue). Data store collections are listed by kernel__data_collections_list.",
    searchKeywords: ["dashboard", "tableau de bord", "chart", "graphique"],
    requiredScopes: [WRITE],
    params: z.object({ query: z.string().max(200).optional() }),
    handler: (async (params: unknown, ctx: HandlerCtx) => {
      const { query } = params as { query?: string }
      const sources = await listEligibleSources(ctx.orgId, await viewerOf(ctx), query)
      return { sources, total: sources.length }
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "dashboards_preview_block"], {
    appName: "kernel",
    name: "dashboards_preview_block",
    readOnly: true,
    // A store source hands the agent app-written documents, the content data_query reads as a
    // taint source: the preview marks the thread the same way. A tool source runs its tool
    // through the core with this thread, so that tool's own taintSource decides.
    taintSource: true,
    taintSourceWhen: async (params: unknown) =>
      (params as { block?: { source?: { kind?: unknown } } } | null)?.block?.source?.kind !==
      "tool",
    deferLoading: true,
    description:
      "Run one dashboard block as you, without saving anything, and return exactly what the chart would draw. Preview every block until its data is right, then save with kernel__dashboards_create or kernel__dashboards_update. A refusal names the reason and eligible alternatives.",
    searchKeywords: ["dashboard", "preview"],
    requiredScopes: [WRITE],
    params: z.object({
      block: z
        .record(z.string(), z.unknown())
        .describe(
          "One block: {id, type, title, source or dataset, map}, as in the spec (a text block needs no preview).",
        ),
      timeRange: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'The dashboard range its {{range.from}} / {{range.to}} read, e.g. {preset:"lastMonth"}. Default: the last 30 days.',
        ),
      datasets: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The spec's datasets, when the block reads one ({dataset: id})."),
      filters: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("The spec's filters, when the block reads one ({{filter.<id>}} or map.where)."),
      filterValues: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          'Values to preview with, e.g. {market: ["FR"]}. Default: each filter\'s default.',
        ),
    }),
    handler: (async (params: unknown, ctx: HandlerCtx) => {
      const p = params as {
        block?: unknown
        timeRange?: unknown
        datasets?: unknown
        filters?: unknown
        filterValues?: Record<string, string[]>
      }
      // The block checked as part of a spec: its dataset and filters must exist.
      const parsedSpec = dashboardSpecSchema.safeParse({
        v: 1,
        ...(p.datasets ? { datasets: p.datasets } : {}),
        ...(p.filters ? { filters: p.filters } : {}),
        blocks: [p.block],
      })
      if (!parsedSpec.success) {
        return { ok: false, reason: "invalid_block", problems: specIssues(parsedSpec.error) }
      }
      const spec = parsedSpec.data
      const block = spec.blocks[0]!
      const tr = timeRangeSchema.safeParse(p.timeRange ?? { preset: "last30d" })
      if (!tr.success)
        return { ok: false, reason: "invalid_time_range", problems: specIssues(tr.error) }
      let values: FilterValues
      try {
        values = normalizeFilterValues(spec, p.filterValues)
      } catch (err) {
        if (err instanceof FilterValueError) {
          return { ok: false, reason: "invalid_filter_values", problems: [err.message] }
        }
        throw err
      }
      const viewer = await viewerOf(ctx)
      const range = resolveTimeRange(tr.data, {
        timeZone: await dashboardTimezone(ctx.orgId),
        now: new Date(),
      })
      const saved = blockSourceOf(block, spec.datasets)
      const withValues = saved
        ? saved.kind === "tool"
          ? { ...saved, params: resolveFilterTokens(saved.params, values, spec) }
          : { ...saved, query: resolveFilterTokens(saved.query, values, spec) }
        : null
      const outcome = await computeBlock(
        withValues ? { ...block, source: withValues, dataset: undefined } : block,
        {
          viewer,
          dashboardId: null,
          range,
          where: resolveWhere(block.map.where, values),
          ...(spec.datasets ? { datasets: spec.datasets } : {}),
          resolveDataset: (src) =>
            src.kind === "tool"
              ? { ...src, params: resolveFilterTokens(src.params, values) }
              : { ...src, query: resolveFilterTokens(src.query, values) },
          ...(ctx.agentExecutionThreadId ? { threadId: ctx.agentExecutionThreadId } : {}),
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        },
      )
      if (outcome.ok) {
        // A block that follows the dashboard range says which days the preview read.
        return blockRangeMode(block, spec.datasets) === "dashboard"
          ? { ok: true, data: outcome.data, range }
          : { ok: true, data: outcome.data }
      }
      const words = !saved
        ? ""
        : saved.kind === "tool"
          ? saved.tool.replace(/[:_-]+/g, " ")
          : saved.collection
      const alternatives =
        saved &&
        (outcome.error === "not_allowed" ||
          outcome.error === "unknown_tool" ||
          outcome.error === "no_access")
          ? (await listEligibleSources(ctx.orgId, viewer, words, 5)).map((s) => s.tool)
          : []
      return { ok: false, reason: outcome.error, message: outcome.message, alternatives }
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "dashboards_list"], {
    appName: "kernel",
    name: "dashboards_list",
    readOnly: true,
    deferLoading: true,
    description:
      "List the dashboards you can see: yours and the organisation's, with their ids and visibility.",
    searchKeywords: ["dashboard", "tableau de bord"],
    requiredScopes: [READ],
    params: z.object({}),
    handler: (async (_params: unknown, ctx: HandlerCtx) =>
      guarded(async () => ({ dashboards: await listDashboards(await viewerOf(ctx), ctx.db) }))) as (
      params: unknown,
      ctx: any,
    ) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "dashboards_get"], {
    appName: "kernel",
    name: "dashboards_get",
    readOnly: true,
    deferLoading: true,
    description:
      "Read one dashboard: title, visibility, version and its spec. Open it for the person with kernel__open_app (app kernel, view dashboard, id).",
    searchKeywords: ["dashboard"],
    requiredScopes: [READ],
    params: z.object({ id: z.string().uuid() }),
    handler: (async (params: unknown, ctx: HandlerCtx) =>
      guarded(async () =>
        getDashboard(await viewerOf(ctx), (params as { id: string }).id, ctx.db),
      )) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "dashboards_history"], {
    appName: "kernel",
    name: "dashboards_history",
    readOnly: true,
    deferLoading: true,
    description:
      'List a dashboard\'s saved versions (the last 20), newest first: version, title, when and by whom, block count. Revert to one with kernel__dashboards_edit {op:"revert", toVersion}.',
    searchKeywords: ["dashboard", "history", "historique", "version", "revert", "annuler"],
    requiredScopes: [READ],
    params: z.object({ id: z.string().uuid() }),
    handler: (async (params: unknown, ctx: HandlerCtx) =>
      guarded(async () => ({
        versions: await listVersions(await viewerOf(ctx), (params as { id: string }).id, ctx.db),
      }))) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  const snapshotParams = {
    dashboardId: z.string().uuid(),
    timeRange: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'The period, e.g. {preset:"lastMonth"} or {preset:"custom", from, to}. Default: the dashboard\'s.',
      ),
    compare: z
      .enum(["lastYear", "previousPeriod", "none"])
      .optional()
      .describe("What the figures are compared with. Default: the dashboard's."),
    filters: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe('Filter values, e.g. {market: ["FR"]}. Default: each filter\'s default.'),
  }

  /** The range options of a snapshot call, checked. */
  const snapshotOptions = (p: {
    timeRange?: unknown
    compare?: string
    filters?: Record<string, string[]>
  }) => {
    const tr = p.timeRange === undefined ? null : timeRangeSchema.safeParse(p.timeRange)
    if (tr && !tr.success) {
      throw new DashboardError(
        "INVALID_REQUEST",
        "the time range is not valid",
        specIssues(tr.error),
      )
    }
    return {
      ...(tr?.success ? { range: tr.data } : {}),
      ...(p.compare ? { compare: p.compare as "lastYear" | "previousPeriod" | "none" } : {}),
      ...(p.filters ? { filters: p.filters } : {}),
    }
  }

  toolRegistry.set([orgId, "kernel", "dashboards_snapshot"], {
    appName: "kernel",
    name: "dashboards_snapshot",
    readOnly: true,
    // Its figures come from the blocks' sources (app data, connector reads): marked as a read
    // of outside data, as a preview of a store source is.
    taintSource: true,
    deferLoading: true,
    description:
      "Read a whole dashboard at once for a period and filters, computed with your access: each block's key figures (a metric's value, its compared value and change, its target; a chart's totals per series with their change and its top labels; a table's first rows), the period and the filters. Pass recipients (user ids) before sharing it: it says who may receive it (they can open the dashboard and read every source themselves). For a PDF of it, kernel__dashboards_pdf. To send it on a schedule, a routine calls this tool (kernel__skill_read build-dashboard).",
    searchKeywords: ["dashboard", "snapshot", "rapport", "report", "weekly", "hebdo", "résumé"],
    requiredScopes: [READ],
    params: z.object({
      ...snapshotParams,
      recipients: z
        .array(z.string().uuid())
        .max(50)
        .optional()
        .describe("The people it will be sent to: each one is checked."),
    }),
    handler: (async (params: unknown, ctx: HandlerCtx) => {
      const p = params as {
        dashboardId: string
        timeRange?: unknown
        compare?: string
        filters?: Record<string, string[]>
        recipients?: string[]
      }
      return guarded(async () => {
        const viewer = await viewerOf(ctx)
        const opts = snapshotOptions(p)
        const computed = await computeDashboard(viewer, p.dashboardId, {
          ...opts,
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        })
        const snapshot = snapshotOf(computed, viewer, p.filters)
        if (!p.recipients?.length) return snapshot
        const recipients = await checkRecipients(ctx.orgId, p.dashboardId, p.recipients)
        return {
          ...snapshot,
          recipients,
          recipientsNote:
            "Send it only to the people with mayReceive true, and say who was left out and why. The figures are computed with your access: someone whose access to rows differs may see other numbers on the dashboard. To give each person their own figures, each gets a routine they own.",
        }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "dashboards_pdf"], {
    appName: "kernel",
    name: "dashboards_pdf",
    deferLoading: true,
    description:
      "Print a dashboard as a PDF for a period and filters, computed with your access (title, period and filters in the header, then each block), staged as a file only you can read: attach its fileId to a reply or a mail. Returns { fileId, filename, byteSize }.",
    searchKeywords: ["dashboard", "pdf", "export", "imprimer", "rapport"],
    requiredScopes: [READ],
    params: z.object(snapshotParams),
    handler: (async (params: unknown, ctx: HandlerCtx) => {
      const p = params as {
        dashboardId: string
        timeRange?: unknown
        compare?: string
        filters?: Record<string, string[]>
      }
      return guarded(async () => {
        const viewer = await viewerOf(ctx)
        const computed = await computeDashboard(viewer, p.dashboardId, {
          ...snapshotOptions(p),
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        })
        const bytes = await renderDashboardPdf(computed, p.filters)
        try {
          return await stagePdfForViewer(viewer, bytes, exportFilename(computed.view.title, "pdf"))
        } catch (err) {
          if (err instanceof StorageFullError) {
            return {
              error: {
                code: "storage_quota_exceeded",
                message: err.message,
                retryable: false,
                status: 413,
              },
            }
          }
          throw err
        }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
    // The PDF is a new kernel file staged for the caller alone (their upload session).
    writesToTable: "kernel.files",
    sinkReadersSelf: true,
    taintSource: true,
  })

  toolRegistry.set([orgId, "kernel", "dashboards_create"], {
    appName: "kernel",
    name: "dashboards_create",
    deferLoading: true,
    description:
      "Save a new dashboard. personal (only you) saves at once; org (everyone) waits for a person's approval. Every block's source must be a read you can make: preview each with kernel__dashboards_preview_block first. Then open it with kernel__open_app (app kernel, view dashboard, id).",
    searchKeywords: ["dashboard", "tableau de bord", "créer"],
    requiredScopes: [WRITE],
    params: z.object({
      title: z.string().trim().min(1).max(200),
      visibility: visibilityParam.default("personal"),
      spec: specParam,
    }),
    handler: (async (params: unknown, ctx: HandlerCtx) => {
      const p = params as { title: string; visibility: "personal" | "org"; spec: DashboardSpec }
      return guarded(async () => {
        const row = await createDashboard(await viewerOf(ctx), p, ctx.db)
        return { id: row.id, title: row.title, visibility: row.visibility, version: row.version }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
    writesToTable: SINK,
    approveScope: ADMIN,
    approvalImpact: "internal",
    gatedWhen: async (params: unknown) =>
      (params as { visibility?: string } | null)?.visibility === "org",
    // One approval card lists the whole new dashboard: more than it lists is refused.
    refuseBeforeGate: async (params: unknown) => {
      const count = cardLineCount(createOperations((params as { spec?: unknown } | null)?.spec))
      return count > MAX_CARD_CHANGES ? tooManyChanges(count) : null
    },
  })
  registerApprovalSummarizer(orgId, "kernel", "dashboards_create", summarizeCreate)

  toolRegistry.set([orgId, "kernel", "dashboards_update"], {
    appName: "kernel",
    name: "dashboards_update",
    deferLoading: true,
    description:
      "Replace a dashboard's whole spec (and its title or visibility): for a wholesale rebuild only. To change some blocks, the title, the range or the visibility, use kernel__dashboards_edit. Your personal dashboard saves at once; an org dashboard, or switching one to org, waits for a person's approval whose card lists every change. Pass ifVersion (from kernel__dashboards_get) so you never overwrite a newer save.",
    searchKeywords: ["dashboard", "modifier"],
    requiredScopes: [WRITE],
    params: z.object({
      id: z.string().uuid(),
      title: z.string().trim().min(1).max(200).optional(),
      visibility: visibilityParam.optional(),
      spec: specParam.optional(),
      ifVersion: z.number().int().min(1).optional(),
    }),
    handler: (async (params: unknown, ctx: HandlerCtx) => {
      const { id, ...input } = params as {
        id: string
        title?: string
        visibility?: "personal" | "org"
        spec?: DashboardSpec
        ifVersion?: number
      }
      return guarded(async () => {
        const row = await updateDashboard(await viewerOf(ctx), id, input, ctx.db)
        return { id: row.id, title: row.title, visibility: row.visibility, version: row.version }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
    writesToTable: SINK,
    approveScope: ADMIN,
    approvalImpact: "internal",
    gatedWhen: async (params: unknown, { orgId: o }: { orgId: string }) => {
      const p = (params ?? {}) as { id?: unknown; visibility?: unknown }
      if (p.visibility === "org") return true
      return (await storedVisibility(o, p.id)) === "org"
    },
    // One approval card lists every change of an org dashboard: more than it lists is refused.
    refuseBeforeGate: async (params: unknown, { orgId: o, userId }) => {
      const p = (params ?? {}) as {
        id?: string
        title?: string
        visibility?: "personal" | "org"
        spec?: unknown
      }
      if (p.spec === undefined || typeof p.id !== "string") return null
      const [row] = await withPrivilegedDb(o, "dashboard-update-card", (tx) =>
        tx
          .select({
            title: dashboards.title,
            visibility: dashboards.visibility,
            ownerUserId: dashboards.ownerUserId,
            spec: dashboards.spec,
          })
          .from(dashboards)
          .where(eq(dashboards.id, p.id!))
          .limit(1),
      )
      // Only a card that will exist is counted: an org dashboard, or the caller's own one shared.
      const carded =
        row?.visibility === "org" || (p.visibility === "org" && row?.ownerUserId === userId)
      if (!row || !carded) return null
      const count = cardLineCount(
        diffDashboards(
          {
            title: row.title,
            visibility: row.visibility,
            spec: row.spec as unknown as DashboardSpec,
          },
          p,
        ),
      )
      return count > MAX_CARD_CHANGES ? tooManyChanges(count) : null
    },
  })
  registerApprovalSummarizer(orgId, "kernel", "dashboards_update", summarizeUpdate)

  toolRegistry.set([orgId, "kernel", "dashboards_edit"], {
    appName: "kernel",
    name: "dashboards_edit",
    deferLoading: true,
    description:
      "Change a dashboard by a list of operations, applied in order and together (all or none): addBlock, updateBlock (partial; a rename is changes {title}), removeBlock, moveBlock, resizeBlock (width 1-3, height 1-2), duplicateBlock, setTitle, setDescription, setTimeRange (the default range and comparison), setVisibility, setDataset / removeDataset (a source shared by several blocks), setFilter / removeFilter (a dashboard filter), revert (back to a saved version, kernel__dashboards_history). Put EVERY change the person asked for in ONE call: on an org dashboard the whole list waits for ONE approval; a personal one saves at once. Pass ifVersion from kernel__dashboards_get. Preview a new or changed block with kernel__dashboards_preview_block first.",
    searchKeywords: ["dashboard", "modifier", "edit", "block", "bloc", "période"],
    requiredScopes: [WRITE],
    params: z.object({
      dashboardId: z.string().uuid(),
      ifVersion: z
        .number()
        .int()
        .min(1)
        .describe("The version kernel__dashboards_get returned: a newer save refuses the edit."),
      operations: z
        .array(editOperationSchema)
        .min(1)
        .describe(
          `1 to ${MAX_CARD_CHANGES} operations, applied in order: {op:"addBlock", block, position?}, {op:"updateBlock", blockId, changes}, {op:"removeBlock", blockId}, {op:"moveBlock", blockId, position}, {op:"setTitle", title}, {op:"setTimeRange", timeRange?, compare?}, {op:"setVisibility", visibility}, {op:"setDataset", id, source}, {op:"removeDataset", id}, {op:"setFilter", filter, position?}, {op:"removeFilter", id}, {op:"resizeBlock", blockId, width?, height?}, {op:"duplicateBlock", blockId, newId?, title?, position?}, {op:"setDescription", description (null removes it)}, {op:"revert", toVersion}. A position is an index (0 = first) or {before: blockId} / {after: blockId}.`,
        ),
    }),
    handler: (async (params: unknown, ctx: HandlerCtx) => {
      const p = params as { dashboardId: string; ifVersion: number; operations: EditOperation[] }
      if (p.operations.length > MAX_CARD_CHANGES) return tooManyChanges(p.operations.length)
      return guarded(async () => {
        const row = await editDashboard(
          await viewerOf(ctx),
          p.dashboardId,
          { ifVersion: p.ifVersion, operations: p.operations },
          ctx.db,
        )
        return {
          id: row.id,
          title: row.title,
          visibility: row.visibility,
          version: row.version,
          blocks: row.spec.blocks.map((b) => b.id),
        }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
    writesToTable: SINK,
    approveScope: ADMIN,
    approvalImpact: "internal",
    gatedWhen: async (params: unknown, { orgId: o }: { orgId: string }) => {
      const p = (params ?? {}) as { dashboardId?: unknown; operations?: unknown }
      const ops = Array.isArray(p.operations) ? p.operations : []
      if (ops.some((op) => (op as { visibility?: unknown } | null)?.visibility === "org")) {
        return true
      }
      return (await storedVisibility(o, p.dashboardId)) === "org"
    },
    // Checked before any approval is staged: an admin never approves an edit that would then be
    // refused (an unknown or duplicate block, an invalid map, a source the requester cannot
    // read, a stale ifVersion), and one card lists every operation.
    refuseBeforeGate: async (params: unknown, ctx) => {
      const p = params as { dashboardId: string; ifVersion: number; operations: EditOperation[] }
      const lines = cardLineCount(p.operations)
      if (lines > MAX_CARD_CHANGES) return tooManyChanges(lines)
      if (ctx.userId === "system") return null
      const viewer = await viewerOf({ ...ctx, scopes: [...ctx.scopes] })
      return guarded(async () => {
        await checkEdit(viewer, p.dashboardId, {
          ifVersion: p.ifVersion,
          operations: p.operations,
        })
        return null
      })
    },
  })
  registerApprovalSummarizer(orgId, "kernel", "dashboards_edit", summarizeEdit)

  toolRegistry.set([orgId, "kernel", "dashboards_delete"], {
    appName: "kernel",
    name: "dashboards_delete",
    deferLoading: true,
    description:
      "Delete a dashboard. Your personal one goes at once; an org dashboard waits for a person's approval.",
    searchKeywords: ["dashboard", "supprimer"],
    requiredScopes: [WRITE],
    params: z.object({ id: z.string().uuid() }),
    handler: (async (params: unknown, ctx: HandlerCtx) =>
      guarded(async () => {
        await deleteDashboard(await viewerOf(ctx), (params as { id: string }).id, ctx.db)
        return { deleted: true }
      })) as (params: unknown, ctx: any) => Promise<unknown>,
    writesToTable: SINK,
    approveScope: ADMIN,
    approvalImpact: "internal",
    gatedWhen: async (params: unknown, { orgId: o }: { orgId: string }) =>
      (await storedVisibility(o, (params as { id?: unknown } | null)?.id)) === "org",
  })
  registerApprovalSummarizer(orgId, "kernel", "dashboards_delete", summarizeDelete)
}
