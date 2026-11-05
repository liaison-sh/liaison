// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/document-template-rules: the organisation's needed-template rules
// (modules/documents/rules-store.ts). Mounted in app.ts behind
// requireScope(kernel:org:admin) for every method: only an org admin reads and
// changes the rules.

import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { idParam } from "~/lib/validators"
import {
  createRule,
  createRuleSchema,
  DocumentRuleError,
  deleteRule,
  getRule,
  listRules,
  listRulesQuerySchema,
  patchRuleSchema,
  updateRule,
} from "./rules-store"

function ruleError(err: DocumentRuleError): Response {
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
    if (err instanceof DocumentRuleError) return ruleError(err)
    throw err
  }
}

export const documentTemplateRuleRoutes = new Hono<AppEnv>()
  .get("/", zValidator("query", listRulesQuerySchema), async (c) => {
    const filter = c.req.valid("query")
    return success(c, await withRequestRls(c, (tx) => listRules(tx, filter)))
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    const rule = await withRequestRls(c, (tx) => getRule(tx, c.req.valid("param").id))
    if (!rule) return ruleError(new DocumentRuleError("not_found", "Rule not found"))
    return success(c, rule)
  })
  .post("/", zValidator("json", createRuleSchema), (c) =>
    guarded(async () => {
      const actor = { orgId: c.get("orgId"), userId: c.get("userId") }
      const input = c.req.valid("json")
      return success(
        c,
        await withRequestRls(c, (tx) => createRule(tx, actor, input)),
        undefined,
        201,
      )
    }),
  )
  .patch("/:id", zValidator("param", idParam), zValidator("json", patchRuleSchema), (c) =>
    guarded(async () => {
      const actor = { orgId: c.get("orgId"), userId: c.get("userId") }
      const { id } = c.req.valid("param")
      const patch = c.req.valid("json")
      return success(c, await withRequestRls(c, (tx) => updateRule(tx, actor, id, patch)))
    }),
  )
  .delete("/:id", zValidator("param", idParam), (c) =>
    guarded(async () => {
      const { id } = c.req.valid("param")
      return success(c, await withRequestRls(c, (tx) => deleteRule(tx, id)))
    }),
  )
