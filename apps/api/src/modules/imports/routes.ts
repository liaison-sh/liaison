// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import runs over HTTP (mounted at /api/imports behind auth in app.ts):
 *
 *   GET  /kinds            the org's import kinds          kernel:imports:read
 *   GET  /                 recent runs (RLS-read; previews  kernel:imports:read
 *                          with ?previews=1; ?approvalRequestId= finds the run an approval started)
 *   GET  /:id              one run                          kernel:imports:read
 *   POST /                 start a run on an uploaded file  kernel:imports:run
 *   POST /:id/cancel       stop a run between batches       kernel:imports:run
 *   POST /:id/undo         undo a finished run              kernel:imports:undo
 *   GET  /transforms       the org's transforms (latest)    kernel:imports:read
 *   POST /previews         preview a transform (dry run)    kernel:imports:run
 *   POST /previews/:id/start  start one's own preview       kernel:imports:run
 *
 * Cancel and undo also need, read live, the kinds' write scopes and to be the
 * person who started the run or an org admin (authority.ts).
 *
 * A person's run reads only an uploaded file they can see (A9) and never a
 * server path (R10: the body is strict, `path`/`filePath` keys are refused).
 * Starting a run checks every kind's write scopes before anything is created;
 * the job checks them again against the person's live permissions.
 */
import { and, desc, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withRlsContext } from "~/db/rls"
import { importRuns } from "~/db/schema/kernel"
import { extractRlsContext } from "~/lib/request-rls"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import { assertRunAuthority } from "~/modules/imports/authority"
import { enqueueImportRun } from "~/modules/imports/job"
import { getImportKind, type ImportKindInfo, listImportKinds } from "~/modules/imports/kinds"
import { loadPreview, previewImport, startFromPreview } from "~/modules/imports/preview"
import { missingWriteScopes } from "~/modules/imports/runner"
import { createImportRun, failRun, getImportRun, requestRunCancel } from "~/modules/imports/runs"
import { FORMAT_KINDS, resolveImportFile } from "~/modules/imports/source"
import { listOrgTransforms } from "~/modules/imports/transform-run"
import { TransformSourceError } from "~/modules/imports/transforms/source"
import { TransformStoreError } from "~/modules/imports/transforms/store"
import { ImportError } from "~/modules/imports/types"
import { undoImportRun } from "~/modules/imports/undo"

const startSchema = z
  .object({
    fileId: z.string().uuid(),
    kinds: z.array(z.string().min(1)).min(1).max(20),
    sourceLabel: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "lowercase letters, digits, - and _ (max 32)"),
    placeholders: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    // The file's format: canonical NDJSON (default), or a standard export
    // read into its one kind's records (`ics` → `calendar.event`).
    format: z.enum(["ndjson", "ics"]).optional(),
  })
  .strict()

const idSchema = z.object({ id: z.string().uuid() })

const listQuery = z.object({
  previews: z.enum(["0", "1"]).optional(),
  approvalRequestId: z.string().uuid().optional(),
})

function errorResponse(err: unknown) {
  if (err instanceof ImportError) {
    return { body: { error: { message: err.message, code: err.code } }, status: err.status }
  }
  if (err instanceof TransformStoreError) {
    return {
      body: { error: { message: err.message, code: err.code } },
      status: (err.code === "transform_not_found" ? 404 : 400) as 400 | 404,
    }
  }
  if (err instanceof TransformSourceError || err instanceof z.ZodError) {
    return {
      body: { error: { message: err.message, code: "invalid_request" } },
      status: 400 as const,
    }
  }
  throw err
}

export const importRoutes = new Hono<AppEnv>()
  .get("/kinds", requireScope("kernel:imports:read"), async (c) => {
    const kinds = await listImportKinds(c.get("orgId"))
    return c.json({
      data: kinds.map((k) => ({
        kind: k.kind,
        app: k.app,
        label: k.decl.label ?? k.kind,
        dedupKey: k.decl.dedupKey,
        writeScopes: k.decl.writeScopes,
        schema: k.decl.schema,
      })),
    })
  })
  .get("/", requireScope("kernel:imports:read"), zValidator("query", listQuery), async (c) => {
    const actor = extractRlsContext(c)
    const q = c.req.valid("query")
    const rows = await withRlsContext(actor, (tx) =>
      tx
        .select()
        .from(importRuns)
        .where(
          and(
            eq(importRuns.orgId, actor.orgId),
            // Previews are dry runs the agent or the Imports view made before
            // starting: listed only when asked for.
            ...(q.previews === "1" ? [] : [eq(importRuns.dryRun, false)]),
            ...(q.approvalRequestId ? [eq(importRuns.approvalRequestId, q.approvalRequestId)] : []),
          ),
        )
        .orderBy(desc(importRuns.createdAt))
        .limit(100),
    )
    return c.json({ data: rows })
  })
  .get("/transforms", requireScope("kernel:imports:read"), async (c) => {
    const rows = await listOrgTransforms(c.get("orgId"))
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        kinds: r.kinds,
        sourceType: r.sourceType,
        connection: r.connectionIdentifier,
        createdAt: r.createdAt,
      })),
    })
  })
  // A person's own preview: the same dry run the agent's import_preview makes.
  .post("/previews", requireScope("kernel:imports:run"), async (c) => {
    const actor = extractRlsContext(c)
    try {
      const body = await c.req.json().catch(() => ({}))
      const out = await previewImport(body, {
        orgId: actor.orgId,
        userId: actor.userId,
        scopes: actor.scopes,
      })
      return c.json({ data: out })
    } catch (err) {
      const r = errorResponse(err)
      return c.json(r.body, r.status)
    }
  })
  // A person starts their own preview directly: the run acts as them.
  .post(
    "/previews/:id/start",
    requireScope("kernel:imports:run"),
    zValidator("param", idSchema),
    async (c) => {
      const actor = extractRlsContext(c)
      try {
        const pv = await loadPreview(actor.orgId, c.req.valid("param").id, actor.userId)
        const run = await startFromPreview({ orgId: actor.orgId, userId: actor.userId }, pv)
        return c.json({ data: run }, 202)
      } catch (err) {
        const r = errorResponse(err)
        return c.json(r.body, r.status)
      }
    },
  )
  .get("/:id", requireScope("kernel:imports:read"), zValidator("param", idSchema), async (c) => {
    const actor = extractRlsContext(c)
    const { id } = c.req.valid("param")
    const [row] = await withRlsContext(actor, (tx) =>
      tx
        .select()
        .from(importRuns)
        .where(and(eq(importRuns.orgId, actor.orgId), eq(importRuns.id, id)))
        .limit(1),
    )
    if (!row) return c.json({ error: { message: "import run not found", code: "not_found" } }, 404)
    return c.json({ data: row })
  })
  .post("/", requireScope("kernel:imports:run"), zValidator("json", startSchema), async (c) => {
    const actor = extractRlsContext(c)
    const body = c.req.valid("json")
    try {
      const kinds: ImportKindInfo[] = []
      for (const name of [...new Set(body.kinds)]) {
        const k = await getImportKind(actor.orgId, name)
        if (!k) throw new ImportError("unknown_kind", `unknown import kind: ${name}`)
        kinds.push(k)
      }
      const format = body.format === "ndjson" ? undefined : body.format
      if (format && kinds.some((k) => k.kind !== FORMAT_KINDS[format])) {
        throw new ImportError(
          "invalid_source",
          `a ${format} file carries ${FORMAT_KINDS[format]} records only`,
        )
      }
      const missing = missingWriteScopes(actor, kinds)
      if (missing.length > 0) {
        throw new ImportError("forbidden", `missing scope(s): ${missing.join(", ")}`)
      }
      await resolveImportFile(actor, body.fileId)
      const run = await createImportRun({
        orgId: actor.orgId,
        kinds: kinds.map((k) => k.kind),
        sourceLabel: body.sourceLabel,
        source: { fileId: body.fileId, ...(format ? { format } : {}) },
        mode: "api",
        dryRun: body.dryRun === true,
        placeholders: body.placeholders === true,
        startedBy: actor.userId,
      })
      try {
        await enqueueImportRun({ orgId: actor.orgId, runId: run.id })
      } catch (err) {
        await failRun(actor.orgId, run.id, "the import could not be queued")
        throw err
      }
      return c.json({ data: run }, 202)
    } catch (err) {
      const r = errorResponse(err)
      return c.json(r.body, r.status)
    }
  })
  .post(
    "/:id/cancel",
    requireScope("kernel:imports:run"),
    zValidator("param", idSchema),
    async (c) => {
      const orgId = c.get("orgId")
      const id = c.req.valid("param").id
      try {
        const existing = await getImportRun(orgId, id)
        if (!existing) throw new ImportError("not_found", "import run not found")
        // Live permissions: the run's owner or an admin, with the kinds' write scopes.
        await assertRunAuthority(orgId, c.get("userId"), existing)
        const run = await requestRunCancel(orgId, id)
        if (!run) throw new ImportError("not_found", "import run not found")
        return c.json({ data: run })
      } catch (err) {
        const r = errorResponse(err)
        return c.json(r.body, r.status)
      }
    },
  )
  .post(
    "/:id/undo",
    requireScope("kernel:imports:undo"),
    zValidator("param", idSchema),
    async (c) => {
      try {
        const report = await undoImportRun(c.get("orgId"), c.req.valid("param").id, {
          userId: c.get("userId"),
        })
        return c.json({ data: report })
      } catch (err) {
        const r = errorResponse(err)
        return c.json(r.body, r.status)
      }
    },
  )
