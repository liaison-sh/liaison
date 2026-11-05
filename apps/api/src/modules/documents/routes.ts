// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/document-templates: the organisation's document templates
// (modules/documents/service.ts). Mounted in app.ts behind
// requireScope({ GET: kernel:files:read, *: kernel:org:admin }): every member
// who reads files reads the templates, only an org admin changes them.

import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { idParam } from "~/lib/validators"
import { previewSavedTemplate } from "./preview"
import {
  listPrintableRecordTypes,
  PRINT_MAX_TEMPLATES,
  type PrintCaller,
  PrintError,
  printDocuments,
} from "./print"
import {
  archiveTemplate,
  createTemplate,
  createTemplateSchema,
  DocumentTemplateError,
  getTemplate,
  listQuerySchema,
  listTemplates,
  patchTemplateSchema,
  replaceFileSchema,
  replaceTemplateFile,
  type TemplateCaller,
  updateTemplate,
} from "./service"

function callerOf(c: Context<AppEnv>): TemplateCaller {
  return {
    orgId: c.get("orgId"),
    userId: c.get("userId"),
    scopes: c.get("scopes") ?? [],
    withRls: (fn) => withRequestRls(c, fn),
  }
}

function templateError(err: DocumentTemplateError): Response {
  return Response.json(
    {
      error: {
        message: err.message,
        code: err.code,
        // `details.field` is what the web client reads (lib/api-client errorDetails).
        ...(err.field !== undefined ? { field: err.field, details: { field: err.field } } : {}),
      },
    },
    { status: err.status },
  )
}

async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof DocumentTemplateError) return templateError(err)
    throw err
  }
}

const previewBodySchema = z.object({ recordId: z.string().min(1).max(200).optional() }).strict()

export const documentTemplateRoutes = new Hono<AppEnv>()
  .get("/", zValidator("query", listQuerySchema), async (c) => {
    const filter = c.req.valid("query")
    return success(c, await withRequestRls(c, (tx) => listTemplates(tx, filter)))
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    const template = await withRequestRls(c, (tx) => getTemplate(tx, c.req.valid("param").id))
    if (!template) {
      return templateError(new DocumentTemplateError("not_found", "Template not found"))
    }
    return success(c, template)
  })
  .post("/", zValidator("json", createTemplateSchema), (c) =>
    guarded(async () =>
      success(c, await createTemplate(callerOf(c), c.req.valid("json")), undefined, 201),
    ),
  )
  .patch("/:id", zValidator("param", idParam), zValidator("json", patchTemplateSchema), (c) =>
    guarded(async () =>
      success(c, await updateTemplate(callerOf(c), c.req.valid("param").id, c.req.valid("json"))),
    ),
  )
  .post("/:id/archive", zValidator("param", idParam), (c) =>
    guarded(async () => success(c, await archiveTemplate(callerOf(c), c.req.valid("param").id))),
  )
  .post("/:id/file", zValidator("param", idParam), zValidator("json", replaceFileSchema), (c) =>
    guarded(async () =>
      success(
        c,
        await replaceTemplateFile(callerOf(c), c.req.valid("param").id, c.req.valid("json")),
      ),
    ),
  )
  // Render the template against a record, or the record type's sample, and
  // send the PDF back: nothing is stored (preview.ts previewSavedTemplate, the same render as the agent's preview).
  .post(
    "/:id/preview",
    zValidator("param", idParam),
    zValidator("json", previewBodySchema),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const out = await previewSavedTemplate(printCallerOf(c), c.req.valid("param").id, {
          ...(body.recordId !== undefined ? { recordId: body.recordId } : {}),
        })
        return success(c, {
          templateId: out.templateId,
          filename: out.filename,
          byteSize: out.bytes.byteLength,
          blanks: out.blanks,
          sample: out.sample,
          pdfBase64: Buffer.from(out.bytes).toString("base64"),
        })
      } catch (err) {
        if (err instanceof PrintError) return printError(err)
        if (err instanceof DocumentTemplateError) return templateError(err)
        throw err
      }
    },
  )

// ---------------------------------------------------------------------------
// /api/documents: print a record through the org's templates (print.ts).
// Mounted in app.ts behind requireScope("kernel:files:read"); printing also
// needs the record's own file writeScope, checked in printDocuments.
// ---------------------------------------------------------------------------

const appNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/, "an app name")
const entityNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, "an entity name")

const printTemplatesQuerySchema = z.object({ app: appNameSchema, entity: entityNameSchema })

const printBodySchema = z
  .object({
    app: appNameSchema,
    entity: entityNameSchema,
    recordId: z.string().min(1).max(200),
    templateIds: z.array(z.string().uuid()).min(1).max(PRINT_MAX_TEMPLATES),
    merge: z.boolean().optional(),
  })
  .strict()

function printCallerOf(c: Context<AppEnv>): PrintCaller {
  return {
    orgId: c.get("orgId"),
    userId: c.get("userId"),
    scopes: c.get("scopes") ?? [],
    actor: extractRlsContext(c),
    actingAgentId: null,
    withRls: (fn) => withRequestRls(c, fn),
  }
}

function printError(err: PrintError): Response {
  return Response.json(
    {
      error: {
        message: err.message,
        code: err.code,
        ...(err.templateId !== undefined ? { templateId: err.templateId } : {}),
      },
    },
    { status: err.status },
  )
}

export const documentRoutes = new Hono<AppEnv>()
  .get("/templates", zValidator("query", printTemplatesQuerySchema), async (c) => {
    const { app, entity } = c.req.valid("query")
    const templates = await withRequestRls(c, (tx) =>
      listTemplates(tx, { recordType: `${app}:${entity}` }),
    )
    return success(
      c,
      templates.filter((t) => t.enabled),
    )
  })
  .get("/record-types", async (c) => success(c, await listPrintableRecordTypes(c.get("orgId"))))
  .post("/print", zValidator("json", printBodySchema), async (c) => {
    try {
      return success(c, await printDocuments(printCallerOf(c), c.req.valid("json")))
    } catch (err) {
      if (err instanceof PrintError) return printError(err)
      throw err
    }
  })
