// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/admin/app-health (`kernel:org:admin`): the app-run health
// (modules/apps/usage/run-health.ts) for an admin.
//
//   the instance operator's org (apps/operator-org.ts)  scope "instance": the
//       same `appRuns` as /diag (this process, the whole cell, the checks)
//   any other org                                       scope "org": the org's
//       own runs cell-wide, per app and lane (no pools, no other org's apps)

import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { isInstanceOperatorOrg } from "~/modules/apps/operator-org"
import { cellRunHealth } from "~/modules/apps/usage/run-health"
import { appRunsDiag } from "~/modules/apps/usage/run-health-checks"

const READ_BUDGET_MS = 2_000

export const appHealthRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const orgId = c.get("orgId")
  if (await isInstanceOperatorOrg(orgId)) {
    return success(c, { scope: "instance" as const, ...(await appRunsDiag(READ_BUDGET_MS)) })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const org = await Promise.race([
    cellRunHealth({ orgId }).catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), READ_BUDGET_MS)
    }),
  ])
  clearTimeout(timer)
  return success(c, { scope: "org" as const, org })
})
