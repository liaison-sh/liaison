// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The shared drives an organization's Drive connection shares (shared-drives.ts):
 *
 *   GET /api/google-drive/shared-drives            the org Drive connections and
 *                                                  the shared drives each shares
 *                                                  (google-drive:accounts:read)
 *   GET /api/google-drive/shared-drives/available  ?accountId= the shared drives
 *                                                  the connecting account is a
 *                                                  member of (admins only)
 *   PUT /api/google-drive/shared-drives            { accountId, drives: [id|name] }
 *                                                  replace the chosen set (admins)
 */
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { MAX_SHARED_DRIVES } from "~/apps/google-drive/drive-scope"
import {
  availableSharedDrives,
  chooseSharedDrives,
  type SharedDrivesCaller,
  SharedDrivesError,
  sharedDrivesState,
} from "~/apps/google-drive/shared-drives"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"

const STATUS: Record<SharedDrivesError["code"], 400 | 403 | 404 | 409> = {
  forbidden: 403,
  not_found: 404,
  not_a_member: 409,
  too_many: 400,
}

const availableSchema = z.object({ accountId: z.string().uuid().optional() })
const chooseSchema = z.object({
  accountId: z.string().uuid().optional(),
  drives: z.array(z.string().min(1).max(500)).max(MAX_SHARED_DRIVES),
})

function who(c: Context<AppEnv>): SharedDrivesCaller {
  return { orgId: c.get("orgId"), userId: c.get("userId"), scopes: c.get("scopes") ?? [] }
}

function refused(c: Context<AppEnv>, err: unknown) {
  if (err instanceof SharedDrivesError) {
    return c.json({ error: { message: err.message, code: err.code } }, STATUS[err.code])
  }
  throw err
}

export const driveSharedDrivesRoutes = new Hono<AppEnv>()
  .get("/shared-drives", async (c) => {
    try {
      return success(c, await sharedDrivesState(who(c)))
    } catch (err) {
      return refused(c, err)
    }
  })
  .get("/shared-drives/available", zValidator("query", availableSchema), async (c) => {
    try {
      const { accountId } = c.req.valid("query")
      return success(c, await availableSharedDrives(who(c), accountId ? { accountId } : {}))
    } catch (err) {
      return refused(c, err)
    }
  })
  .put("/shared-drives", zValidator("json", chooseSchema), async (c) => {
    try {
      const { accountId, drives } = c.req.valid("json")
      return success(c, await chooseSharedDrives(who(c), accountId ? { accountId } : {}, drives))
    } catch (err) {
      return refused(c, err)
    }
  })
