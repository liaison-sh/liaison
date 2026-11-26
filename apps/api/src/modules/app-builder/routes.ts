// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REST for the app builder tab, under /api/apps/builder/drafts (a person's own
// calls: their scopes decide, nothing here is gated).
//
//   GET    /                       list (kernel:apps:build)
//   POST   /        {base_name, title, template?, files?}   a new draft, version 1
//   PUT    /:id/files {files, mode?, message, title?}     the draft's next version
//   GET    /:id/status             the draft, its app as it runs now and its publishes
//   GET    /:id[?n=]               one draft and a version, with its preview frame URL
//   GET    /:id/versions           kept versions
//   POST   /:id/check   {n?}       build + type check (check.ts)
//   POST   /:id/preview {n?, entry, params?, freshStore?}   read-only preview run (preview.ts)
//   POST   /:id/restore {n}        version n's files as the next version
//   POST   /:id/discard
//   POST   /:id/publish {n?}       kernel:apps:build AND kernel:apps:admin: prepare
//                                  (build + pin) and install the pinned bytes at once.
//                                  From a restricted (device-flow) session, e.g. the
//                                  remote CLI: nothing is installed; the call runs
//                                  kernel:apps_build_publish (kernel:apps:build), which
//                                  parks the same approval card as MCP (202, the
//                                  approval's id); a holder of kernel:apps:admin
//                                  decides it in the app.
//   GET    /:id/:n/ui.js           the version's built interface, as text, for the
//                                  page to hand to the frame (kernel:apps:build)
//   GET    /:id/:n/frame?t=        the frame document the interface runs in: opaque
//                                  origin, no session (app-frame.ts); outside the
//                                  bearer chain (a frame load sends no header), so
//                                  it is served against a short-lived token from GET /:id.
//                                  Its tool calls go to POST /:id/preview, read-only.
//
// Errors: { error: { message, code, details? } } with 400/403/404/409/413/429.

import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { customAppsEnabled } from "~/lib/edition"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import { checkDraft } from "~/modules/app-builder/check"
import {
  createDraft,
  discardDraft,
  draftAppName,
  getBuildArtifact,
  getDraft,
  listDrafts,
  listDraftVersions,
  restoreDraftVersion,
  type TxRunner,
  updateDraftFiles,
} from "~/modules/app-builder/drafts"
import { activeCustomApp, publishHistory } from "~/modules/app-builder/installed"
import { previewDraft } from "~/modules/app-builder/preview"
import { executePublish, preparePublish } from "~/modules/app-builder/publish"
import { DRAFT_TEMPLATES, templateFiles } from "~/modules/app-builder/templates"
import { builderToolError, patchFiles } from "~/modules/app-builder/tools"
import { appFrameResponse, appFrameRuntime } from "~/modules/apps/app-frame"
import { executeTool } from "~/modules/apps/execute-tool"
import { restToolCall } from "~/modules/apps/rest-tool-call"
import { boundHost, signUiBundleToken, verifyUiBundleToken } from "~/modules/apps/ui-bundle-token"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { hasScope } from "~/modules/permissions/permissions"

const BUILD = "kernel:apps:build"
const ADMIN = "kernel:apps:admin"

const idParam = z.object({ id: z.string().uuid() })
const versionParam = z.object({ id: z.string().uuid(), n: z.coerce.number().int().min(1) })
const nBody = z.object({ n: z.number().int().min(1).optional() })
const fileMap = z.record(z.string(), z.string().nullable())
const createBody = z.object({
  base_name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  title: z.string().trim().min(1).max(200),
  template: z.enum(DRAFT_TEMPLATES).optional(),
  files: fileMap.optional(),
})
const updateBody = z.object({
  files: fileMap,
  mode: z.enum(["patch", "full"]).optional(),
  message: z.string().max(500),
  title: z.string().trim().min(1).max(200).optional(),
})
const previewBody = z.object({
  n: z.number().int().min(1).optional(),
  entry: z.object({ kind: z.enum(["tool", "job", "webhook"]), name: z.string().min(1).max(100) }),
  params: z.record(z.string(), z.unknown()).optional(),
  freshStore: z.boolean().optional(),
})

/** The request's RLS transactions, one short one per step (builds and installs run between). */
const requestDb = (c: Context<AppEnv>): TxRunner => ({ run: (fn) => withRequestRls(c, fn) })

/** The frame token's subject: a draft version, never an installed app's name. */
const frameSubject = (draftId: string) => `builder-draft:${draftId}`

/** A refusal as the route's error envelope (the tools' mapping). */
function refuse(c: Context<AppEnv>, err: unknown) {
  const mapped = builderToolError(err).error
  return c.json(
    {
      error: {
        message: mapped.message,
        code: mapped.code,
        ...("details" in mapped && mapped.details ? { details: mapped.details } : {}),
      },
    },
    mapped.status as 400,
  )
}

export const builderRoutes = new Hono<AppEnv>()
  // Off on this server (LIAISON_CUSTOM_APPS): every route answers 404, as if absent.
  .use("*", async (c, next) => {
    if (!customAppsEnabled()) return c.json({ error: { message: "Not found" } }, 404)
    await next()
  })
  .get("/drafts", requireScope(BUILD), async (c) => {
    const drafts = await withRequestRls(c, (tx) => listDrafts(tx))
    return success(c, drafts)
  })
  // A person's own edit (no agent turn, so no turn taint), the tool's same checks.
  .post("/drafts", requireScope(BUILD), zValidator("json", createBody), async (c) => {
    const caller = { orgId: c.get("orgId"), userId: c.get("userId") }
    const body = c.req.valid("json")
    try {
      const appName = draftAppName(caller.orgId, body.base_name)
      const files = body.files
        ? patchFiles({}, body.files, "full")
        : templateFiles(body.template ?? "store-crud", appName, body.title)
      const { draft, version } = await withRequestRls(c, (tx) =>
        createDraft(tx, caller, {
          baseName: body.base_name,
          title: body.title,
          files,
          message: body.files
            ? "Created"
            : `Created from the ${body.template ?? "store-crud"} template`,
        }),
      )
      return success(
        c,
        { draftId: draft.id, appName, n: version.n, files: version.files },
        undefined,
        201,
      )
    } catch (err) {
      return refuse(c, err)
    }
  })
  .put(
    "/drafts/:id/files",
    requireScope(BUILD),
    zValidator("param", idParam),
    zValidator("json", updateBody),
    async (c) => {
      const caller = { orgId: c.get("orgId"), userId: c.get("userId") }
      const id = c.req.valid("param").id
      const body = c.req.valid("json")
      try {
        const version = await withRequestRls(c, async (tx) => {
          const { version: latest } = await getDraft(tx, id)
          return updateDraftFiles(tx, caller, {
            draftId: id,
            files: patchFiles(latest.files, body.files, body.mode ?? "patch"),
            message: body.message,
            ...(body.title ? { title: body.title } : {}),
          })
        })
        return success(c, { draftId: id, n: version.n, files: Object.keys(version.files) })
      } catch (err) {
        return refuse(c, err)
      }
    },
  )
  .get("/drafts/:id/status", requireScope(BUILD), zValidator("param", idParam), async (c) => {
    const orgId = c.get("orgId")
    try {
      const { draft, version } = await withRequestRls(c, (tx) =>
        getDraft(tx, c.req.valid("param").id),
      )
      const appName = draft.publishedAppName ?? draftAppName(orgId, draft.baseName)
      const active = draft.publishedAppName ? await activeCustomApp(orgId, appName) : null
      // `builder:draft/<draftId>/<n>`: which version of this draft runs now.
      const runningN = active?.sourceUrl?.match(/^builder:draft\/[^/]+\/(\d+)$/)?.[1]
      return success(c, {
        draftId: draft.id,
        title: draft.title,
        status: draft.status,
        appName,
        latestVersion: version.n,
        latestBuild: version.build,
        installed: active
          ? {
              version: active.version,
              sha256: active.sha256,
              draftVersion: runningN ? Number(runningN) : null,
              grantedScopes: active.grantedScopes,
              grantedDomains: active.grantedDomains,
            }
          : null,
        publishes: draft.publishedAppName ? await publishHistory({ orgId, appName }) : [],
      })
    } catch (err) {
      return refuse(c, err)
    }
  })
  .get("/drafts/:id", requireScope(BUILD), zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param")
    const n = c.req.query("n")
    try {
      const { draft, version } = await withRequestRls(c, (tx) =>
        getDraft(tx, id, n ? { version: Number(n) } : {}),
      )
      const ui = version.build?.ok && version.build.uiSha256
      const t = ui
        ? await signUiBundleToken(frameSubject(id), String(version.n), boundHost(c))
        : null
      return success(c, {
        draft,
        appName: draft.publishedAppName ?? draftAppName(draft.orgId, draft.baseName),
        version,
        preview: t
          ? {
              frameUrl: `/api/apps/builder/drafts/${id}/${version.n}/frame?t=${encodeURIComponent(t)}`,
              uiUrl: `/api/apps/builder/drafts/${id}/${version.n}/ui.js`,
            }
          : null,
      })
    } catch (err) {
      return refuse(c, err)
    }
  })
  .get("/drafts/:id/versions", requireScope(BUILD), zValidator("param", idParam), async (c) => {
    try {
      const versions = await withRequestRls(c, (tx) =>
        listDraftVersions(tx, c.req.valid("param").id),
      )
      return success(c, versions)
    } catch (err) {
      return refuse(c, err)
    }
  })
  .post(
    "/drafts/:id/check",
    requireScope(BUILD),
    zValidator("param", idParam),
    zValidator("json", nBody),
    async (c) => {
      const caller = { orgId: c.get("orgId"), userId: c.get("userId") }
      const { n } = c.req.valid("json")
      try {
        const result = await checkDraft(requestDb(c), caller, {
          draftId: c.req.valid("param").id,
          ...(n ? { n } : {}),
        })
        return success(c, result)
      } catch (err) {
        return refuse(c, err)
      }
    },
  )
  .post(
    "/drafts/:id/preview",
    requireScope(BUILD),
    zValidator("param", idParam),
    zValidator("json", previewBody),
    async (c) => {
      const actor = extractRlsContext(c)
      const body = c.req.valid("json")
      try {
        const result = await previewDraft(
          {
            orgId: actor.orgId,
            userId: actor.userId,
            scopes: actor.scopes,
            dimensionGrants: actor.dimensionGrants,
          },
          {
            draftId: c.req.valid("param").id,
            entry: body.entry,
            ...(body.n ? { n: body.n } : {}),
            ...(body.params ? { params: body.params } : {}),
            ...(body.freshStore ? { freshStore: true } : {}),
          },
        )
        return success(c, result)
      } catch (err) {
        return refuse(c, err)
      }
    },
  )
  .post(
    "/drafts/:id/restore",
    requireScope(BUILD),
    zValidator("param", idParam),
    zValidator("json", z.object({ n: z.number().int().min(1) })),
    async (c) => {
      const caller = { orgId: c.get("orgId"), userId: c.get("userId") }
      try {
        const version = await withRequestRls(c, (tx) =>
          restoreDraftVersion(tx, caller, {
            draftId: c.req.valid("param").id,
            n: c.req.valid("json").n,
          }),
        )
        return success(c, version)
      } catch (err) {
        return refuse(c, err)
      }
    },
  )
  .post("/drafts/:id/discard", requireScope(BUILD), zValidator("param", idParam), async (c) => {
    const caller = { orgId: c.get("orgId"), userId: c.get("userId") }
    try {
      const row = await withRequestRls(c, (tx) => discardDraft(tx, caller, c.req.valid("param").id))
      return success(c, row)
    } catch (err) {
      return refuse(c, err)
    }
  })
  .post(
    "/drafts/:id/publish",
    requireScope(BUILD),
    zValidator("param", idParam),
    zValidator("json", nBody),
    async (c) => {
      const userId = c.get("userId")
      const caller = { orgId: c.get("orgId"), userId }
      const { n } = c.req.valid("json")
      const draftId = c.req.valid("param").id
      // A restricted session is a program's token: nobody clicked. It installs
      // nothing; it asks, through the gated tool, exactly as MCP does.
      if (c.get("sessionRestricted") === true) {
        const call = await restToolCall(c)
        const result = await executeTool({
          toolName: "kernel:apps_build_publish",
          orgId: caller.orgId,
          actor: extractRlsContext(c),
          threadId: call.threadId,
          params: { draftId, ...(n ? { n } : {}) },
          origin: call.origin,
        })
        const blocked = result.blocked
        if (blocked?.reason === "gated" && blocked.approvalRequestId) {
          return success(
            c,
            {
              status: "pending_approval",
              approvalId: blocked.approvalRequestId,
              summary: blocked.summary,
            },
            undefined,
            202,
          )
        }
        // Parked for another reason (a disclosure decision, a refusal): said as it is.
        if (blocked) return success(c, { blocked }, undefined, 409)
        // The preflight refused (a build error, a stale draft): the route's error envelope.
        const refused = (
          result.data as {
            error?: { message?: string; code?: string; status?: number; details?: unknown }
          } | null
        )?.error
        return c.json(
          {
            error: {
              message: refused?.message ?? "The publish was not asked for",
              code: refused?.code ?? "publish_refused",
              ...(refused?.details ? { details: refused.details } : {}),
            },
          },
          (refused?.status ?? 422) as 400,
        )
      }
      // A person's own publish installs at once: they decide it, so they hold the decider's scope.
      if (!hasScope(ADMIN, (c.get("scopes") as string[]) ?? [])) {
        throw new PermissionDeniedError({ missingScope: ADMIN })
      }
      try {
        const db = requestDb(c)
        const prepared = await preparePublish(db, caller, {
          draftId,
          ...(n ? { n } : {}),
        })
        const result = await executePublish(db, { ...caller, installedBy: userId }, prepared.pin)
        return success(c, result)
      } catch (err) {
        return refuse(c, err)
      }
    },
  )
  .get(
    "/drafts/:id/:n/ui.js",
    requireScope(BUILD),
    zValidator("param", versionParam),
    async (c) => {
      const { id, n } = c.req.valid("param")
      const notFound = c.json({ error: { message: "Not found" } }, 404)
      try {
        const bytes = await withRequestRls(c, async (tx) => {
          const { version } = await getDraft(tx, id, { version: n })
          const sha = version.build?.ok ? version.build.uiSha256 : undefined
          if (!sha) return null
          const artifact = await getBuildArtifact(tx, { draftId: id, sha256: sha })
          return artifact?.kind === "ui" ? artifact.bytes : null
        })
        if (!bytes) return notFound
        // Text the page hands to the frame, never a script this origin runs.
        return c.body(new Uint8Array(bytes), 200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
        })
      } catch {
        return notFound
      }
    },
  )
  .get("/drafts/:id/:n/frame", zValidator("param", versionParam), async (c) => {
    const { id, n } = c.req.valid("param")
    if (!(await verifyUiBundleToken(c.req.query("t"), frameSubject(id), String(n), boundHost(c)))) {
      return c.json({ error: { message: "Not found" } }, 404)
    }
    const runtime = await appFrameRuntime()
    if (runtime === null) {
      return c.json({ error: { message: "This server has no app frame" } }, 503)
    }
    return appFrameResponse(runtime)
  })
