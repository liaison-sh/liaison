// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Google Picker routes for a Drive connected with `drive.file` only (picker.ts):
 *
 *   GET  /api/google-drive/picker          the caller's Drive accounts: mode,
 *                                          picked items, sync state; whether the
 *                                          deployment configured the Picker.
 *                                          ?origin=&threadId= (an agent's card):
 *                                          also the ids picked through that card
 *   POST /api/google-drive/picker/ticket   a one-time link to the Picker page
 *                                          (picker-page.ts) for one account
 *   POST /api/google-drive/picker/items    add / remove picked items, then sync
 */
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { pickedItemSchema } from "~/apps/google-drive/drive-mode"
import {
  DrivePickerError,
  drivePickerState,
  type PickerActor,
  pickerAccount,
  savePicks,
} from "~/apps/google-drive/picker"
import { cardPickIds, PICK_ORIGIN_RE } from "~/apps/google-drive/picker-announce"
import { createPickerTicket, pickerPageUrl } from "~/apps/google-drive/picker-page"
import { KnowledgeError } from "~/apps/knowledge/service"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"

/** The card a state read is for: its picks come back as `cardPicks`. */
const stateQuerySchema = z.object({
  origin: z.string().regex(PICK_ORIGIN_RE).optional(),
  threadId: z.string().uuid().optional(),
})
const accountSchema = z.object({ accountId: z.string().uuid() })
/** `origin`: the id a `kernel__drive_picker` card carries (picker-announce.ts). */
const ticketSchema = accountSchema.extend({ origin: z.string().regex(PICK_ORIGIN_RE).optional() })
const itemsSchema = accountSchema.extend({
  add: z.array(pickedItemSchema).max(500).default([]),
  remove: z.array(z.string().min(1).max(128)).max(500).default([]),
})

const STATUS: Record<DrivePickerError["code"], 403 | 404 | 409> = {
  not_found: 404,
  forbidden: 403,
  not_picked_mode: 409,
  picker_not_configured: 409,
}

function who(c: Context<AppEnv>): PickerActor {
  return {
    orgId: c.get("orgId"),
    userId: c.get("userId"),
    scopes: c.get("scopes") ?? [],
    dimensionGrants: c.get("dimensionGrants") ?? {},
    roles: c.get("roles") ?? [],
  }
}

function errorBody(
  err: unknown,
): { body: { error: { message: string; code: string } }; status: 400 | 403 | 404 | 409 } | null {
  if (err instanceof DrivePickerError) {
    return { body: { error: { message: err.message, code: err.code } }, status: STATUS[err.code] }
  }
  if (err instanceof KnowledgeError) {
    return {
      body: { error: { message: err.message, code: err.code } },
      status: err.code === "FORBIDDEN" ? 403 : 400,
    }
  }
  return null
}

export const drivePickerRoutes = new Hono<AppEnv>()
  .get("/picker", zValidator("query", stateQuerySchema), async (c) => {
    const actor = who(c)
    const { origin, threadId } = c.req.valid("query")
    const state = await drivePickerState(actor)
    if (!origin || !threadId) return success(c, state)
    return success(c, { ...state, cardPicks: await cardPickIds(actor, { origin, threadId }) })
  })
  .post("/picker/ticket", zValidator("json", ticketSchema), async (c) => {
    const actor = who(c)
    const body = c.req.valid("json")
    try {
      const account = await pickerAccount(actor, body.accountId)
      const ticket = await createPickerTicket({
        orgId: actor.orgId,
        userId: actor.userId,
        scopes: [...actor.scopes],
        dimensionGrants: actor.dimensionGrants,
        roles: actor.roles,
        accountId: account.id,
        identifier: account.identifier,
        ...(body.origin ? { origin: body.origin } : {}),
      })
      return success(c, { url: pickerPageUrl(ticket) })
    } catch (err) {
      const mapped = errorBody(err)
      if (mapped) return c.json(mapped.body, mapped.status)
      throw err
    }
  })
  .post("/picker/items", zValidator("json", itemsSchema), async (c) => {
    const body = c.req.valid("json")
    try {
      const result = await savePicks(who(c), body.accountId, {
        add: body.add,
        remove: body.remove,
      })
      return success(c, result)
    } catch (err) {
      const mapped = errorBody(err)
      if (mapped) return c.json(mapped.body, mapped.status)
      throw err
    }
  })
