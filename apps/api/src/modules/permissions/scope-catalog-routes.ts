// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { getScopeCatalog } from "~/modules/permissions/scope-catalog"

export const scopeCatalogRoutes = new Hono<AppEnv>()

scopeCatalogRoutes.get("/", (c) => {
  const orgId = c.get("orgId")
  return success(c, getScopeCatalog(orgId))
})
