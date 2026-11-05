// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared e2e lane reset — `POST /api/_test/lane/reset`.
//
// A shared e2e lane (packages/test-helpers/src/e2e-lane.ts) keeps one server
// process across scenario files and puts the worker's database, Redis keys and
// search index back to their post-boot snapshot between files. What the
// process holds in memory about that data is dropped here, so the next file
// cannot read a previous file's state out of a cache: the auth state of a user
// whose roles a file changed, an org's hidden-app set, install trust, the
// operator org, the demo marker, scripted agent turns, and the external-API
// mock modes a file selected. Caches that boot itself fills from the app
// registration (scope and dimension catalogs) stay: the registration is the
// same before and after the reset.
//
// Gated on `qaSeedRoutesEnabled` like every other `_test` route.
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { clearScriptedTurns } from "~/modules/agent/providers/scripted-model-provider"
import { resetInstallTrustCache } from "~/modules/apps/install-trust"
import { resetOperatorOrgCache } from "~/modules/apps/operator-org"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { invalidateDemoMarker } from "~/modules/demo/demo-org"
import { resetBoxtalMockMode } from "./boxtal-mock-fetch"
import { resetMetaMockState } from "./meta-mock-fetch"
import { pennylaneMockClearRequests, resetPennylaneMockMode } from "./pennylane-mock-fetch"
import { clearShopifyMockOrders, resetShopifyMockMode } from "./shopify-mock-fetch"
import { resetSocialMockState } from "./social-mock-fetch"

export const laneResetTestRoutes = new Hono<AppEnv>()

laneResetTestRoutes.post("/reset", async (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  invalidateAuthCache()
  resetInstallTrustCache()
  resetOperatorOrgCache()
  invalidateDemoMarker()
  await clearScriptedTurns()
  resetBoxtalMockMode()
  resetMetaMockState()
  resetPennylaneMockMode()
  pennylaneMockClearRequests()
  resetShopifyMockMode()
  clearShopifyMockOrders()
  resetSocialMockState()
  const orgs = await withSystemDb("lane-reset:orgs", (db) =>
    db.select({ id: organizations.id }).from(organizations),
  )
  // The app state of every org is re-read from the reset data on next use.
  forgetOrgApps()
  return c.json({ data: { orgs: orgs.length } })
})
