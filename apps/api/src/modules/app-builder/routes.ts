// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REST for the app builder tab, under /api/apps/builder/drafts (a person's own
// calls: their scopes decide, nothing here is gated).
//
//   GET    /                       list (kernel:apps:build)
//   GET    /:id[?n=]               one draft and a version, with its preview frame URL
//   GET    /:id/versions           kept versions
//   POST   /:id/check   {n?}       build + type check (check.ts)
//   POST   /:id/preview {n?, entry, params?}   read-only preview run (preview.ts)
//   POST   /:id/restore {n}        version n's files as the next version
//   POST   /:id/discard
//   POST   /:id/publish {n?}       kernel:apps:admin AND kernel:apps:build: prepare
//                                  (build + pin) and install the pinned bytes at once
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
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import { checkDraft } from "~/modules/app-builder/check"
import {
  discardDraft,
  draftAppName,
  getBuildArtifact,
  getDraft,
  listDrafts,
  listDraftVersions,
  restoreDraftVersion,
} from "~/modules/app-builder/drafts"
import { previewDraft } from "~/modules/app-builder/preview"
import { executePublish, preparePublish } from "~/modules/app-builder/publish"
import { builderToolError } from "~/modules/app-builder/tools"
import { appFrameResponse, appFrameRuntime } from "~/modules/apps/app-frame"
import { boundHost, signUiBundleToken, verifyUiBundleToken } from "~/modules/apps/ui-bundle-token"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { hasScope } from "~/modules/permissions/permissions"

const BUILD = "kernel:apps:build"
const ADMIN = "kernel:apps:admin"

const idParam = z.object({ id: z.string().uuid() })
const versionParam = z.object({ id: z.string().uuid(), n: z.coerce.number().int().min(1) })
const nBody = z.object({ n: z.number().int().min(1).optional() })
const previewBody = z.object({
  n: z.number().int().min(1).optional(),
  entry: z.object({ kind: z.enum(["tool", "job", "webhook"]), name: z.string().min(1).max(100) }),
  params: z.record(z.string(), z.unknown()).optional(),
})

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
  .get("/drafts", requireScope(BUILD), async (c) => {
    const drafts = await withRequestRls(c, (tx) => listDrafts(tx))
    return success(c, drafts)
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
        const result = await withRequestRls(c, (tx) =>
          checkDraft(tx, caller, { draftId: c.req.valid("param").id, ...(n ? { n } : {}) }),
        )
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
    requireScope(ADMIN),
    zValidator("param", idParam),
    zValidator("json", nBody),
    async (c) => {
      if (!hasScope(BUILD, (c.get("scopes") as string[]) ?? [])) {
        throw new PermissionDeniedError({ missingScope: BUILD })
      }
      const userId = c.get("userId")
      const caller = { orgId: c.get("orgId"), userId }
      const { n } = c.req.valid("json")
      try {
        const result = await withRequestRls(c, async (tx) => {
          const prepared = await preparePublish(tx, caller, {
            draftId: c.req.valid("param").id,
            ...(n ? { n } : {}),
          })
          return executePublish(tx, { ...caller, installedBy: userId }, prepared.pin)
        })
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
