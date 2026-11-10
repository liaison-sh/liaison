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

import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { dashboards, userRoles } from "~/db/schema/kernel"
import { type ApprovalSummarizer, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { computeBlock, dashboardTimezone } from "~/modules/dashboards/execute"
import {
  DateTokenError,
  dateTokensIn,
  hasDateTokens,
  resolveDateTokens,
} from "~/modules/dashboards/relative-dates"
import {
  createDashboard,
  DashboardError,
  deleteDashboard,
  getDashboard,
  listDashboards,
  updateDashboard,
} from "~/modules/dashboards/service"
import { listEligibleSources } from "~/modules/dashboards/sources"
import { type DashboardSpec, dashboardBlockSchema, specIssues } from "~/modules/dashboards/spec"

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
async function viewerOf(ctx: HandlerCtx): Promise<UserContext> {
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
    blocks: z.array(z.record(z.string(), z.unknown())).max(24),
  })
  .describe(
    "The dashboard spec: {v:1, blocks:[{id, type, title, width, source, map, refreshSec?}]}, at most 24 blocks. kernel__skill_read build-dashboard for one worked block per chart type.",
  )

/** A block's date tokens with what each is today: `{{today-30d}} = 2026-10-11`. */
function tokenDates(source: Record<string, unknown>, timeZone: string): string {
  const value = source.kind === "store" ? source.query : source.params
  const now = new Date()
  return dateTokensIn(value)
    .slice(0, 4)
    .map((token) => {
      try {
        return `${token} = ${resolveDateTokens(token, { timeZone, now })}`
      } catch (err) {
        if (err instanceof DateTokenError) return `${token} (not a date token)`
        throw err
      }
    })
    .join(", ")
}

/** The zone a card's token dates are shown in: the org's, looked up only when a block has tokens. */
async function cardTimezone(spec: unknown, orgId: string): Promise<string> {
  return hasDateTokens((spec as { blocks?: unknown } | null)?.blocks)
    ? dashboardTimezone(orgId)
    : "UTC"
}

/** One block's lines for an approval card: what it draws and from where. */
function blockLines(spec: unknown, timeZone: string, max = 6): string[] {
  const blocks = Array.isArray((spec as { blocks?: unknown })?.blocks)
    ? ((spec as { blocks: unknown[] }).blocks as Record<string, unknown>[])
    : []
  const lines = blocks.slice(0, max).map((b) => {
    const source = (b.source ?? {}) as Record<string, unknown>
    const from =
      source.kind === "store"
        ? `store ${String(source.app)}/${String(source.collection)}`
        : String(source.tool ?? "(no source)")
    const dates = tokenDates(source, timeZone)
    return `${String(b.type ?? "block")} "${String(b.title ?? b.id ?? "")}" from ${from}${dates ? `, dates ${dates} (today, rolling)` : ""}`
  })
  if (blocks.length > max) lines.push(`and ${blocks.length - max} more blocks`)
  if (blocks.length === 0) lines.push("No blocks.")
  return lines
}

// A create parks for an org dashboard, and also for a personal one when the turn's taint parks it
// (scope-taint rule 8b): the card says which, from the visibility the call carries.
const summarizeCreate: ApprovalSummarizer = async (raw, ctx) => {
  const p = (raw ?? {}) as { title?: string; spec?: unknown; visibility?: string }
  const tz = await cardTimezone(p.spec, ctx.orgId)
  if (p.visibility !== "org") {
    return {
      kind: "dashboard_create",
      title: `Save the personal dashboard "${p.title ?? ""}"`,
      lines: ["Only its author will see it.", ...blockLines(p.spec, tz)],
    }
  }
  return {
    kind: "dashboard_create",
    title: `Share the dashboard "${p.title ?? ""}" with the organisation`,
    lines: [
      "Everyone in the organisation will see it, each with their own access.",
      ...blockLines(p.spec, tz),
    ],
  }
}

const summarizeUpdate: ApprovalSummarizer = async (raw, ctx) => {
  const p = (raw ?? {}) as { id?: string; title?: string; spec?: unknown; visibility?: string }
  const [current] =
    typeof p.id === "string"
      ? await ctx.tx
          .select({
            title: dashboards.title,
            visibility: dashboards.visibility,
            spec: dashboards.spec,
          })
          .from(dashboards)
          .where(eq(dashboards.id, p.id))
          .limit(1)
      : []
  const title = p.title ?? current?.title ?? ""
  const lines: string[] = []
  if (p.visibility && p.visibility !== current?.visibility) {
    lines.push(
      p.visibility === "org"
        ? "It becomes visible to the whole organisation."
        : "It becomes personal: only its owner sees it.",
    )
  } else {
    lines.push("Everyone in the organisation sees this dashboard.")
  }
  if (p.title && current && p.title !== current.title)
    lines.push(`Title: "${current.title}" → "${p.title}".`)
  lines.push(
    ...blockLines(
      p.spec ?? current?.spec,
      await cardTimezone(p.spec ?? current?.spec, ctx.orgId),
      5,
    ),
  )
  return {
    kind: "dashboard_update",
    title: `Change the org dashboard "${title}"`,
    lines: lines.slice(0, 8),
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
        .describe("One block: {id, type, title, source, map}, as in the spec."),
    }),
    handler: (async (params: unknown, ctx: HandlerCtx) => {
      const parsed = dashboardBlockSchema.safeParse((params as { block?: unknown }).block)
      if (!parsed.success)
        return { ok: false, reason: "invalid_block", problems: specIssues(parsed.error) }
      const viewer = await viewerOf(ctx)
      const outcome = await computeBlock(parsed.data, {
        viewer,
        dashboardId: null,
        ...(ctx.agentExecutionThreadId ? { threadId: ctx.agentExecutionThreadId } : {}),
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      })
      if (outcome.ok) return { ok: true, data: outcome.data }
      const source = parsed.data.source
      const words = source.kind === "tool" ? source.tool.replace(/[:_-]+/g, " ") : source.collection
      const alternatives =
        outcome.error === "not_allowed" ||
        outcome.error === "unknown_tool" ||
        outcome.error === "no_access"
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
  })
  registerApprovalSummarizer(orgId, "kernel", "dashboards_create", summarizeCreate)

  toolRegistry.set([orgId, "kernel", "dashboards_update"], {
    appName: "kernel",
    name: "dashboards_update",
    deferLoading: true,
    description:
      "Change a dashboard's title, blocks (the whole spec) or visibility. Your personal dashboard saves at once; an org dashboard, or switching one to org, waits for a person's approval. Pass ifVersion (from kernel__dashboards_get) so you never overwrite a newer save.",
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
  })
  registerApprovalSummarizer(orgId, "kernel", "dashboards_update", summarizeUpdate)

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
