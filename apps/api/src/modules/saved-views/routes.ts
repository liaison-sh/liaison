// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSavedViewSchema, updateSavedViewSchema } from "@liaison/shared"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRlsContext } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import {
  cloneSavedView,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  SavedViewError,
  updateSavedView,
} from "~/modules/saved-views/service"

export const savedViewsRoutes = new Hono<AppEnv>()

const savedViewIdParam = z.object({ id: z.string().uuid() })

function mapError(err: unknown): never {
  if (err instanceof SavedViewError) {
    if (err.code === "SCOPE_DENIED") throw new HTTPException(403, { message: err.message })
    if (err.code === "NOT_FOUND") throw new HTTPException(404, { message: err.message })
    if (err.code === "USER_REQUIRED") throw new HTTPException(401, { message: err.message })
    throw new HTTPException(422, { message: err.message })
  }
  throw err as Error
}

savedViewsRoutes.get("/", async (c) => {
  const app = c.req.query("app")
  const viewId = c.req.query("viewId")
  if (!app || !viewId) {
    throw new HTTPException(400, { message: "app and viewId query params are required" })
  }
  const ctx = extractRlsContext(c)
  try {
    const rows = await listSavedViews(ctx, { app, viewId })
    return success(c, rows)
  } catch (err) {
    mapError(err)
  }
})

savedViewsRoutes.post("/", zValidator("json", createSavedViewSchema), async (c) => {
  const ctx = extractRlsContext(c)
  const body = c.req.valid("json")
  try {
    const row = await createSavedView(ctx, body)
    return success(c, row, undefined, 201)
  } catch (err) {
    mapError(err)
  }
})

savedViewsRoutes.patch(
  "/:id",
  zValidator("param", savedViewIdParam),
  zValidator("json", updateSavedViewSchema),
  async (c) => {
    const id = c.req.param("id")
    const ctx = extractRlsContext(c)
    const body = c.req.valid("json")
    try {
      const row = await updateSavedView(ctx, id, body)
      return success(c, row)
    } catch (err) {
      mapError(err)
    }
  },
)

savedViewsRoutes.delete("/:id", zValidator("param", savedViewIdParam), async (c) => {
  const id = c.req.param("id")
  const ctx = extractRlsContext(c)
  try {
    await deleteSavedView(ctx, id)
    return success(c, { deleted: true })
  } catch (err) {
    mapError(err)
  }
})

savedViewsRoutes.post("/:id/clone", zValidator("param", savedViewIdParam), async (c) => {
  const id = c.req.param("id")
  const ctx = extractRlsContext(c)
  try {
    const row = await cloneSavedView(ctx, id)
    return success(c, row, undefined, 201)
  } catch (err) {
    mapError(err)
  }
})
