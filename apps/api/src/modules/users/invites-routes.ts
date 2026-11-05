// SPDX-License-Identifier: FSL-1.1-ALv2
import { createInviteSchema } from "@liaison/shared"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { createInvitation } from "~/modules/users/invites"

export const invites = new Hono<AppEnv>()

invites.post("/", zValidator("json", createInviteSchema), async (c) => {
  const { email, roleId } = c.req.valid("json")
  const orgId = c.get("orgId")
  const invitedBy = c.get("userId")

  const actorScopes = c.get("scopes")
  const actorDimensionGrants = c.get("dimensionGrants")
  const result = await withRequestRls(c, async (tx) => {
    return createInvitation(tx, {
      orgId,
      email,
      roleId,
      invitedBy,
      actorScopes,
      actorDimensionGrants,
    })
  })
  if (!result) {
    throw new HTTPException(404, { message: "Role not found" })
  }
  if ("error" in result) {
    if (result.error === "SCOPE_ESCALATION") {
      throw new HTTPException(403, {
        message: "Cannot invite with a role that grants scopes you do not hold",
      })
    }
    if (result.error === "DIMENSION_ESCALATION") {
      throw new HTTPException(403, {
        message: "Cannot invite with a role that grants data access you do not hold",
      })
    }
    if (result.error === "INVITE_PENDING") {
      throw new HTTPException(409, { message: "Invitation already pending for this email" })
    }
    throw new HTTPException(409, { message: "User already exists" })
  }
  return success(c, result, undefined, 201)
})
