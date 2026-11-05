// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/sharing: the share dialog's pickers, for any shareable resource (a
// contact, a document). Any authenticated member: the rows are the org's
// people and roles, which RLS already lets every member read.

import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { listShareMembers, listShareRoles } from "~/modules/sharing/targets"

export const sharingRoutes = new Hono<AppEnv>()

sharingRoutes.get("/members", async (c) => {
  const orgId = c.get("orgId")
  return success(c, await withRequestRls(c, (tx) => listShareMembers(tx, orgId)))
})

sharingRoutes.get("/roles", async (c) => {
  const orgId = c.get("orgId")
  return success(c, await withRequestRls(c, (tx) => listShareRoles(tx, orgId)))
})
