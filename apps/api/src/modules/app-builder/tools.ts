// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's app builder tools (kernel, scope kernel:apps:build unless said
// otherwise), registered once per org from agent/tools/kernel-tools.ts. The
// kernel skill `build-app` (agent/prompts/kernel/build-app.md) teaches the loop:
// create (from a template) -> update -> check -> preview -> publish.
//
//  - apps_build_create / _update / _get / _list / _versions / _restore /
//    _discard: drafts and their versions (drafts.ts).
//  - apps_build_check: build + type check, errors with file and line (check.ts).
//  - apps_build_preview: one entry point run read-only on the draft's own
//    store namespace (preview.ts); a taint source (app-written output).
//  - apps_build_logs: an app's lines (kernel:apps:logs) or a draft's preview
//    lines (their person's only, logs.ts); a taint source.
//  - apps_build_publish: GATED, decided by a person holding kernel:apps:admin,
//    never auto-approved. Its preflight builds and PINS the version (publish.ts):
//    the card shows name, version, package sha and the delta against the
//    active version; the pinned params come from the preflight only and the
//    request takes no edit (`payloadImmutable`): a change is a new request.

import { z } from "zod"
import { customAppsEnabled } from "~/lib/edition"
import { handlerTurnTaint } from "~/modules/agent/tools/chat-tools"
import { BuildBusyError } from "~/modules/app-builder/build/governance"
import { checkDraft } from "~/modules/app-builder/check"
import {
  createDraft,
  type DraftCaller,
  DraftError,
  discardDraft,
  draftAppName,
  getDraft,
  inTx,
  listDrafts,
  listDraftVersions,
  restoreDraftVersion,
  type TxRunner,
  updateDraftFiles,
} from "~/modules/app-builder/drafts"
import { AppLogsQueryError, READ_APP_LOGS_MAX_LIMIT, readAppLogs } from "~/modules/app-builder/logs"
import { previewDraft } from "~/modules/app-builder/preview"
import { executePublish, preparePublish, summarizePin } from "~/modules/app-builder/publish"
import { DRAFT_TEMPLATES, type DraftTemplate, templateFiles } from "~/modules/app-builder/templates"
import { type ApprovalSummarizer, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import type { AppContext } from "~/modules/apps/context"
import { hasScope } from "~/modules/permissions/permissions"

const BUILD = "kernel:apps:build"
const ADMIN = "kernel:apps:admin"
const LOGS = "kernel:apps:logs"
// Drafts are read only by holders of BUILD: the RLS of app_drafts, app_draft_versions
// and app_build_artifacts lets nobody else SELECT them (0277_app_builder.sql), so
// every ungated write declares BUILD as its readers (`sinkReadScope`): on a tainted
// turn it runs when every holder of BUILD holds what the turn read, and parks for a
// disclosure decision otherwise (scope-taint.ts, rules 6a and 8b). Undeclared, every
// draft step parked, since a table without declared readers is judged by nobody.
const SINK = "kernel.app_drafts"
const KEYWORDS = ["app builder", "build an app", "custom app", "créer une app", "application"]

const STATUS: Record<string, number> = {
  not_found: 404,
  version_not_found: 404,
  base_name_taken: 409,
  draft_discarded: 409,
  published_name_immutable: 409,
  app_owned_by_other_draft: 409,
  app_not_built_by_builder: 409,
  publish_stale: 409,
  pin_mismatch: 409,
  preview_busy: 409,
  custom_apps_off: 404,
  files_too_large: 413,
}

/** A refusal the agent can act on: code, message, status and the details (errors with lines). */
export function builderToolError(err: unknown) {
  if (err instanceof DraftError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        status: STATUS[err.code] ?? 400,
        retryable: false,
        ...(err.details ? { details: err.details } : {}),
      },
    }
  }
  if (err instanceof BuildBusyError) {
    return {
      error: {
        code: "build_busy",
        message: err.message,
        status: 429,
        retryable: true,
        ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
      },
    }
  }
  if (err instanceof AppLogsQueryError) {
    return { error: { code: err.code, message: err.message, status: 400, retryable: false } }
  }
  throw err
}

async function guarded<T>(fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (err) {
    return builderToolError(err)
  }
}

// The turn's taint rides along, so a draft version records what its writer had read.
const callerOf = (ctx: AppContext): DraftCaller => ({
  orgId: ctx.orgId,
  userId: ctx.userId,
  taintScopes: handlerTurnTaint(ctx),
})

/**
 * The transactions of a tool that builds or installs (`ownsTransactions`): the
 * call's session, a short transaction per step, so no connection sits idle in
 * a transaction across a build or the install's health gate. Where the caller
 * holds a live transaction instead (a test, a nested call), its steps join it.
 */
const dbOf = (ctx: AppContext): TxRunner => ctx.rlsSession ?? inTx(ctx.db)

const draftId = z
  .string()
  .uuid()
  .describe("The draft's id (from kernel__apps_build_create or _list).")
const versionN = z
  .number()
  .int()
  .min(1)
  .describe("A version number of the draft (default: the latest).")
const filesParam = z
  .record(z.string(), z.string().nullable())
  .describe(
    "Files by name: app.manifest.json, handlers.ts, ui.tsx, README.md (text). With mode patch (default) only the files given change and null removes ui.tsx or README.md; with mode full they are the whole draft.",
  )
const entryParam = z.object({
  kind: z.enum(["tool", "job", "webhook"]),
  name: z.string().min(1).max(100).describe("The tool, job or webhook name in the manifest."),
})

/** The files of a patch over `base`: given files replace, null removes. */
export function patchFiles(
  base: Record<string, string>,
  patch: Record<string, string | null>,
  mode: "patch" | "full",
): Record<string, string> {
  const out: Record<string, string> = mode === "full" ? {} : { ...base }
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete out[name]
    else out[name] = value
  }
  return out
}

function summaryOf(d: {
  id: string
  baseName: string
  title: string
  status: string
  publishedAppName: string | null
  latestVersion: number
  updatedAt: Date
}) {
  return {
    draftId: d.id,
    baseName: d.baseName,
    title: d.title,
    status: d.status,
    publishedAppName: d.publishedAppName,
    latestVersion: d.latestVersion,
    updatedAt: d.updatedAt.toISOString(),
  }
}

const summarizePublish: ApprovalSummarizer = async (raw, ctx) => {
  const pin = (raw as { pin?: unknown } | null)?.pin
  const s = await summarizePin(ctx.tx, ctx.orgId, pin)
  return { kind: "app_publish", impact: "internal", ...s }
}

/** The app builder's tools, every one of them (absent while custom apps are off). */
export const APP_BUILDER_TOOL_NAMES = [
  "apps_build_create",
  "apps_build_update",
  "apps_build_get",
  "apps_build_list",
  "apps_build_versions",
  "apps_build_restore",
  "apps_build_check",
  "apps_build_preview",
  "apps_build_logs",
  "apps_build_publish",
  "apps_build_discard",
] as const

/**
 * Registers the kernel's app builder tools for `orgId`, only while this server
 * lets organisations have their own apps (LIAISON_CUSTOM_APPS,
 * customAppsEnabled): off, none is in the catalog.
 */
export function registerAppBuilderTools(orgId: string): void {
  if (!customAppsEnabled()) {
    for (const name of APP_BUILDER_TOOL_NAMES) toolRegistry.delete([orgId, "kernel", name])
    return
  }
  toolRegistry.set([orgId, "kernel", "apps_build_create"], {
    appName: "kernel",
    name: "apps_build_create",
    deferLoading: true,
    description:
      "Start a new app for the organisation: a draft from a working template (store-crud: one stored collection with a list and an add tool; read-only: one read tool), or from your own files. Returns the draft id, the app name its scopes must start with, and the files. Then change it with kernel__apps_build_update, check, preview, publish. kernel__skill_read build-app first.",
    searchKeywords: KEYWORDS,
    requiredScopes: [BUILD],
    writesToTable: SINK,
    sinkReadScope: BUILD,
    params: z.object({
      base_name: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,40}$/)
        .describe("Short lowercase name, letters digits and '-' (e.g. returns)."),
      title: z.string().trim().min(1).max(200),
      template: z.enum(DRAFT_TEMPLATES).optional(),
      files: filesParam.optional(),
    }),
    handler: (async (params: unknown, ctx: AppContext) => {
      const p = params as {
        base_name: string
        title: string
        template?: DraftTemplate
        files?: Record<string, string | null>
      }
      return guarded(async () => {
        const appName = draftAppName(ctx.orgId, p.base_name)
        const files = p.files
          ? patchFiles({}, p.files, "full")
          : templateFiles(p.template ?? "store-crud", appName, p.title)
        const { draft, version } = await createDraft(ctx.db, callerOf(ctx), {
          baseName: p.base_name,
          title: p.title,
          files,
          message: p.files ? "Created" : `Created from the ${p.template ?? "store-crud"} template`,
        })
        return {
          draftId: draft.id,
          appName,
          n: version.n,
          files: version.files,
          next: "Edit with kernel__apps_build_update, then kernel__apps_build_check and kernel__apps_build_preview; publish with kernel__apps_build_publish.",
        }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "apps_build_update"], {
    appName: "kernel",
    name: "apps_build_update",
    deferLoading: true,
    description:
      "Save new files for a draft as its next version (the last 20 are kept). mode patch (default) replaces only the files you give; full replaces them all. Always send a whole file, never a diff.",
    searchKeywords: KEYWORDS,
    requiredScopes: [BUILD],
    writesToTable: SINK,
    sinkReadScope: BUILD,
    params: z.object({
      draftId,
      files: filesParam,
      mode: z.enum(["patch", "full"]).optional(),
      message: z.string().max(500).describe("What changed, in a few words."),
      title: z.string().trim().min(1).max(200).optional(),
    }),
    handler: (async (params: unknown, ctx: AppContext) => {
      const p = params as {
        draftId: string
        files: Record<string, string | null>
        mode?: "patch" | "full"
        message: string
        title?: string
      }
      return guarded(async () => {
        const { version: latest } = await getDraft(ctx.db, p.draftId)
        const files = patchFiles(latest.files, p.files, p.mode ?? "patch")
        const version = await updateDraftFiles(ctx.db, callerOf(ctx), {
          draftId: p.draftId,
          files,
          message: p.message,
          ...(p.title ? { title: p.title } : {}),
        })
        return { draftId: p.draftId, n: version.n, files: Object.keys(version.files) }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "apps_build_get"], {
    appName: "kernel",
    name: "apps_build_get",
    readOnly: true,
    deferLoading: true,
    description:
      "Read a draft: its status, app name and one version's files and build (the latest by default).",
    searchKeywords: KEYWORDS,
    requiredScopes: [BUILD],
    params: z.object({ draftId, n: versionN.optional() }),
    handler: (async (params: unknown, ctx: AppContext) => {
      const p = params as { draftId: string; n?: number }
      return guarded(async () => {
        const { draft, version } = await getDraft(
          ctx.db,
          p.draftId,
          p.n !== undefined ? { version: p.n } : {},
        )
        return {
          ...summaryOf(draft),
          appName: draft.publishedAppName ?? draftAppName(ctx.orgId, draft.baseName),
          n: version.n,
          message: version.message,
          files: version.files,
          build: version.build,
        }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "apps_build_list"], {
    appName: "kernel",
    name: "apps_build_list",
    readOnly: true,
    deferLoading: true,
    description: "List the organisation's app drafts, newest change first.",
    searchKeywords: KEYWORDS,
    requiredScopes: [BUILD],
    params: z.object({ includeDiscarded: z.boolean().optional() }),
    handler: (async (params: unknown, ctx: AppContext) =>
      guarded(async () => ({
        drafts: (
          await listDrafts(ctx.db, {
            includeDiscarded: (params as { includeDiscarded?: boolean }).includeDiscarded === true,
          })
        ).map(summaryOf),
      }))) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "apps_build_versions"], {
    appName: "kernel",
    name: "apps_build_versions",
    readOnly: true,
    deferLoading: true,
    description: "List a draft's kept versions (newest first) with their message and build result.",
    searchKeywords: KEYWORDS,
    requiredScopes: [BUILD],
    params: z.object({ draftId }),
    handler: (async (params: unknown, ctx: AppContext) =>
      guarded(async () => ({
        versions: (await listDraftVersions(ctx.db, (params as { draftId: string }).draftId)).map(
          (v) => ({ ...v, createdAt: v.createdAt.toISOString() }),
        ),
      }))) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "apps_build_restore"], {
    appName: "kernel",
    name: "apps_build_restore",
    deferLoading: true,
    description:
      "Make an earlier version's files the draft's newest version (n+1). Publishing it ships it as the next version; tables it no longer declares are kept.",
    searchKeywords: KEYWORDS,
    requiredScopes: [BUILD],
    writesToTable: SINK,
    sinkReadScope: BUILD,
    params: z.object({ draftId, n: versionN }),
    handler: (async (params: unknown, ctx: AppContext) => {
      const p = params as { draftId: string; n: number }
      return guarded(async () => {
        const version = await restoreDraftVersion(ctx.db, callerOf(ctx), p)
        return { draftId: p.draftId, n: version.n, restoredFrom: p.n }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "apps_build_check"], {
    appName: "kernel",
    name: "apps_build_check",
    deferLoading: true,
    description:
      "Build a draft version (the latest by default) and type-check it against the app SDK. Returns ok and every error with its file and line. Fix and check again until ok.",
    searchKeywords: KEYWORDS,
    requiredScopes: [BUILD],
    writesToTable: SINK,
    sinkReadScope: BUILD,
    ownsTransactions: true,
    params: z.object({ draftId, n: versionN.optional() }),
    handler: (async (params: unknown, ctx: AppContext) => {
      const p = params as { draftId: string; n?: number }
      return guarded(() => checkDraft(dbOf(ctx), callerOf(ctx), p))
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "apps_build_preview"], {
    appName: "kernel",
    name: "apps_build_preview",
    readOnly: true,
    // The result and the log lines are written by app code.
    taintSource: true,
    deferLoading: true,
    description:
      "Run one tool, job or webhook handler of a draft version as you, without installing it. Read-only; ctx.store reads and writes go to a scratch space of this draft, kept for the next preview of the same version (so you can add in one preview and list in the next) and emptied when you preview another version or pass freshStore: true. One preview of a draft at a time (else preview_busy: retry). Returns the result and the log lines. Before the first publish ctx.db and ctx.fetch are not available.",
    searchKeywords: KEYWORDS,
    requiredScopes: [BUILD],
    ownsTransactions: true,
    params: z.object({
      draftId,
      n: versionN.optional(),
      entry: entryParam,
      params: z.record(z.string(), z.unknown()).optional(),
      freshStore: z
        .boolean()
        .optional()
        .describe("true: empty the draft's scratch store first, even for the same version."),
    }),
    handler: (async (params: unknown, ctx: AppContext) => {
      const p = params as {
        draftId: string
        n?: number
        entry: { kind: "tool" | "job" | "webhook"; name: string }
        params?: Record<string, unknown>
        freshStore?: boolean
      }
      return guarded(() =>
        previewDraft(
          {
            orgId: ctx.orgId,
            userId: ctx.userId,
            scopes: ctx.scopes ?? [],
            dimensionGrants: ctx.dimensionGrants ?? {},
            ...(ctx.agentExecutionThreadId ? { threadId: ctx.agentExecutionThreadId } : {}),
          },
          p,
        ),
      )
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "apps_build_logs"], {
    appName: "kernel",
    name: "apps_build_logs",
    readOnly: true,
    taintSource: true,
    deferLoading: true,
    description:
      "Read log lines, newest first: an app's (give app; needs kernel:apps:logs) or a draft's preview runs (give draftId; only your own runs).",
    searchKeywords: [...KEYWORDS, "logs"],
    requiredScopes: [BUILD],
    params: z.object({
      app: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,62}$/)
        .optional(),
      draftId: z.string().uuid().optional(),
      since: z.string().datetime({ offset: true }).optional(),
      level: z.enum(["debug", "info", "warn", "error"]).optional(),
      runId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(READ_APP_LOGS_MAX_LIMIT).optional(),
    }),
    handler: (async (params: unknown, ctx: AppContext) => {
      const p = params as {
        app?: string
        draftId?: string
        since?: string
        level?: "debug" | "info" | "warn" | "error"
        runId?: string
        limit?: number
      }
      if (p.app !== undefined && !hasScope(LOGS, ctx.scopes ?? [])) {
        return {
          error: {
            code: "scope_denied",
            message: `An app's logs need ${LOGS}; a draft's own preview lines need only its draftId.`,
            status: 403,
            retryable: false,
          },
        }
      }
      return guarded(async () => ({
        lines: await readAppLogs(ctx.db, {
          ...(p.app !== undefined ? { app: p.app } : {}),
          ...(p.draftId !== undefined ? { draftId: p.draftId } : {}),
          ...(p.since ? { since: new Date(p.since) } : {}),
          ...(p.level ? { level: p.level } : {}),
          ...(p.runId ? { runId: p.runId } : {}),
          ...(p.limit ? { limit: p.limit } : {}),
        }),
      }))
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })

  toolRegistry.set([orgId, "kernel", "apps_build_publish"], {
    appName: "kernel",
    name: "apps_build_publish",
    deferLoading: true,
    description:
      "Publish a draft version (the latest by default) as the organisation's app. GATED: a person holding kernel:apps:admin approves the exact build (name, version, package sha, what access changes). Report it as waiting for approval, never as done. To change anything after asking, withdraw the request and ask again. After it is approved the app's tools are found with kernel__tool_search.",
    searchKeywords: [...KEYWORDS, "publish", "publier"],
    requiredScopes: [BUILD],
    writesToTable: SINK,
    gated: true,
    approveScope: ADMIN,
    noAutoApprove: true,
    approvalImpact: "internal",
    trustBoundary: "user",
    // The preflight pins what the person approves; the caller's own value is dropped.
    pinnedParams: ["pin"],
    payloadImmutable: true,
    ownsTransactions: true,
    params: z.object({
      draftId,
      n: versionN.optional(),
      pin: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Set by the server: never pass it."),
    }),
    preflight: (async (params: unknown, ctx: AppContext) => {
      const p = params as { draftId: string; n?: number }
      try {
        const prepared = await preparePublish(dbOf(ctx), callerOf(ctx), p)
        return { ok: true, noAutoApprove: true, pinnedParams: { pin: prepared.pin } }
      } catch (err) {
        return builderToolError(err)
      }
    }) as (params: unknown, ctx: any) => Promise<unknown>,
    handler: (async (params: unknown, ctx: AppContext) => {
      const p = params as { pin?: unknown }
      return guarded(async () => {
        const published = await executePublish(
          dbOf(ctx),
          { ...callerOf(ctx), installedBy: ctx.approverUserId ?? ctx.userId },
          p.pin,
          { approvalRequestId: ctx.approvalRequestId ?? null },
        )
        return {
          ...published,
          next: "Find its tools with kernel__tool_search (its name) and call them with kernel__call_tool. Members get its member scopes automatically; the app is On.",
        }
      })
    }) as (params: unknown, ctx: any) => Promise<unknown>,
  })
  registerApprovalSummarizer(orgId, "kernel", "apps_build_publish", summarizePublish)

  toolRegistry.set([orgId, "kernel", "apps_build_discard"], {
    appName: "kernel",
    name: "apps_build_discard",
    deferLoading: true,
    description:
      "Discard a draft: its built bytes go, its base name is free again unless it published an app (a published app stays installed).",
    searchKeywords: KEYWORDS,
    requiredScopes: [BUILD],
    writesToTable: SINK,
    sinkReadScope: BUILD,
    params: z.object({ draftId }),
    handler: (async (params: unknown, ctx: AppContext) =>
      guarded(async () => {
        const row = await discardDraft(
          ctx.db,
          callerOf(ctx),
          (params as { draftId: string }).draftId,
        )
        return { draftId: row.id, status: row.status }
      })) as (params: unknown, ctx: any) => Promise<unknown>,
  })
}
