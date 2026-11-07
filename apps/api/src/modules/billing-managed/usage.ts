// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's current usage as a plan change sends it (spec S17): the control
// plane compares it to the target plan's caps and refuses a change that would
// leave the org above one of them.
//  - seats: the members the seat cap counts (modules/org/caps.ts countSeats);
//  - storageBytes: the bytes of the org's stored files;
//  - customApps: the org's own private apps, the count the cap refuses at
//    (org/caps.ts countCustomApps);
//  - storageEstimateBytes: the nightly estimate of everything the org occupies
//    (cloud/storage-estimate.ts), absent before a first measure. Information
//    only: Control compares a plan's caps to storageBytes, never to this.

import type { cloudPlanUsageSchema } from "@liaison/control-plane-contract"
import { sql as drizzleSql, eq } from "drizzle-orm"
import type { z } from "zod"
import { withSystemDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel"
import { countCustomApps, countSeats, storageEstimateOf } from "~/modules/org/caps"

export type PlanUsage = z.infer<typeof cloudPlanUsageSchema>

export async function currentPlanUsage(orgId: string): Promise<PlanUsage> {
  const estimate = await storageEstimateOf(orgId)
  return withSystemDb("billing-managed:usage", async (db) => {
    const seats = await countSeats(db, orgId)
    const [bytes] = await db
      .select({ total: drizzleSql<string>`COALESCE(SUM(${files.sizeBytes}), 0)::text` })
      .from(files)
      .where(eq(files.orgId, orgId))
    return {
      seats,
      storageBytes: Math.min(Number(bytes?.total ?? 0), Number.MAX_SAFE_INTEGER),
      customApps: await countCustomApps(db, orgId),
      ...(estimate ? { storageEstimateBytes: estimate.bytes } : {}),
    }
  })
}
