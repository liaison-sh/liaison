// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/trusted-senders: the org's trusted senders (modules/contacts/trusted-senders.ts). Read by
// anyone who reads contacts or tickets; changed by a contacts admin or a tickets settings admin.
// Mounted outside /api/contacts so a tickets admin without contacts write access can use it from
// a ticket's "unverified sender" badge.

import { trustedSenderCreateSchema } from "@liaison/shared"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { idParam } from "~/lib/validators"
import {
  addTrustedSender,
  listTrustedSenders,
  removeTrustedSender,
  TRUSTED_SENDERS_ADMIN_SCOPES,
  TRUSTED_SENDERS_READ_SCOPES,
} from "~/modules/contacts/trusted-senders"
import { hasScope } from "~/modules/permissions/permissions"

function requireAny(scopes: string[], held: string[]): void {
  if (!scopes.some((s) => hasScope(s, held))) {
    throw new HTTPException(403, { message: `Missing scope: one of ${scopes.join(", ")}` })
  }
}

export const trustedSendersRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    requireAny(TRUSTED_SENDERS_READ_SCOPES, c.get("scopes") ?? [])
    return success(c, await listTrustedSenders(c.get("orgId")))
  })
  .post("/", zValidator("json", trustedSenderCreateSchema), async (c) => {
    requireAny(TRUSTED_SENDERS_ADMIN_SCOPES, c.get("scopes") ?? [])
    const row = await addTrustedSender(c.get("orgId"), c.get("userId"), c.req.valid("json"))
    return success(c, row, undefined, 201)
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    requireAny(TRUSTED_SENDERS_ADMIN_SCOPES, c.get("scopes") ?? [])
    const removed = await removeTrustedSender(c.get("orgId"), c.get("userId"), c.req.param("id"))
    if (!removed) throw new HTTPException(404, { message: "Trusted sender not found" })
    return success(c, { removed: true })
  })
