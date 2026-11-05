// SPDX-License-Identifier: FSL-1.1-ALv2
import { bulkDispatchRequestSchema } from "@liaison/shared"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { extractRlsContext } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { BulkDispatchError, runBulkDispatch } from "~/modules/apps/bulk-dispatch"

export const bulkRoutes = new Hono<AppEnv>()

function bulkHttpError(status: number, code: string, message: string): never {
  const err = new Error(message) as Error & { status: number; code: string }
  err.status = status
  err.code = code
  throw err
}

bulkRoutes.post("/:app/bulk/:action", async (c) => {
  const app = c.req.param("app")
  const action = c.req.param("action")

  const raw = (await c.req.json().catch(() => ({}))) as unknown
  const parsed = bulkDispatchRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (issue) {
      const path = issue.path.join(".")
      if (path === "ids" && issue.code === "too_big") {
        bulkHttpError(422, "BATCH_TOO_LARGE", `selection exceeds 100 items`)
      }
      if (path === "idempotencyKey") {
        bulkHttpError(422, "INVALID_IDEMPOTENCY_KEY", "idempotencyKey must be a UUID")
      }
      if (path === "ids" && issue.code === "custom") {
        bulkHttpError(422, "DUPLICATE_IDS", issue.message)
      }
    }
    bulkHttpError(422, "INVALID_BODY", issue?.message ?? "Invalid request body")
  }

  try {
    const result = await runBulkDispatch({
      app,
      action,
      ids: parsed.data.ids,
      params: parsed.data.params,
      idempotencyKey: parsed.data.idempotencyKey,
      actor: extractRlsContext(c),
      // REST entry point: a browser bulk-select action, same as the single-tool
      // REST route in modules/apps/routes.ts. The human click IS the approval.
      origin: "human-ui",
    })
    return success(c, result)
  } catch (err) {
    if (err instanceof BulkDispatchError) {
      bulkHttpError(err.status, err.code, err.message)
    }
    throw err
  }
})
