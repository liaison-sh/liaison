// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `GET /api/billing/state`. The edition is read per request (lib/edition.ts):
//  - self-hosted: `{mode: "self_hosted", byokEnabled: true}`, as always;
//  - managed: the billing state the control plane last pushed to this cell
//    (modules/cloud/billing.ts), served locally so a control plane outage never
//    blocks it. It carries no payment page URL. Before the first push:
//    `{mode: "managed", billingUnavailable: true, stale: true}`.
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { isManagedEdition } from "~/lib/edition"
import { success } from "~/lib/response"
import { readManagedBillingState } from "~/modules/cloud/billing"

export const billingStateRoutes = new Hono<AppEnv>().get("/", async (c) => {
  if (!isManagedEdition()) {
    return success(c, {
      mode: "self_hosted",
      byokEnabled: true,
    })
  }
  const state = await readManagedBillingState(c.get("orgId") as string)
  if (!state) return success(c, { mode: "managed", billingUnavailable: true, stale: true })
  return success(c, state)
})
