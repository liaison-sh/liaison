// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > System, "Liaison team": read and change the two instance-wide
// switches (register this server, allow bug report forwarding, send bug reports
// only to the Liaison team).
//
//   GET /api/admin/liaison-team   kernel:org:admin. The switches, the registration
//                                 state and, for the instance operator only, the
//                                 server id and the outbox counts.
//   PUT /api/admin/liaison-team   kernel:org:admin + requireInstanceOperator.
//   GET /api/admin/liaison-team/performance
//                                 kernel:org:admin + requireInstanceOperator. The
//                                 app performance report exactly as it would be
//                                 sent now (performance.ts), whether or not it is on.
//
// The switches are instance-wide while `kernel:org:admin` is org-scoped, so on a
// multi-tenant instance (demo, managed) a visitor's admin may read the switches
// but not change them, and never sees the server id or the outbox.

import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { canManageInstanceApps, requireInstanceOperator } from "~/modules/apps/operator-org"
import { performanceData } from "./performance"
import { type LiaisonTeamStatus, readStatus, setSharing } from "./settings"

const updateSchema = z
  .object({
    register: z.boolean().optional(),
    forwardBugReports: z.boolean().optional(),
    bugReportsTeamOnly: z.boolean().optional(),
    sharePerformance: z.boolean().optional(),
  })
  .strict()

function view(status: LiaisonTeamStatus, canManage: boolean) {
  return {
    available: status.available,
    canManage,
    register: {
      enabled: status.sharing.register,
      state: status.state,
      ...(status.lastError ? { lastError: status.lastError } : {}),
      ...(canManage ? { instanceId: status.instanceId, registeredAt: status.registeredAt } : {}),
    },
    forwardBugReports: { enabled: status.sharing.forwardBugReports },
    bugReportsTeamOnly: { enabled: status.sharing.bugReportsTeamOnly },
    sharePerformance: { enabled: status.sharing.sharePerformance },
    ...(canManage ? { outbox: status.outbox } : {}),
  }
}

export const liaisonTeamRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const canManage = await canManageInstanceApps(c.get("orgId"))
    return success(c, view(await readStatus(), canManage))
  })
  .put("/", requireInstanceOperator, zValidator("json", updateSchema), async (c) => {
    const change = c.req.valid("json")
    await setSharing(change, { userId: c.get("userId"), orgId: c.get("orgId") })
    return success(c, view(await readStatus(), true))
  })
  .get("/performance", requireInstanceOperator, async (c) =>
    success(c, { message: "performance", data: await performanceData() }),
  )
