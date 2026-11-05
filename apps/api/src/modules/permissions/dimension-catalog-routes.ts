// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { getDimensionCatalog } from "~/modules/permissions/dimension-catalog"

export const dimensionCatalogRoutes = new Hono<AppEnv>()

dimensionCatalogRoutes.get("/", (c) => {
  const orgId = c.get("orgId")
  return success(c, getDimensionCatalog(orgId))
})
