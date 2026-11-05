// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's current usage as a plan change sends it (spec S17): the control
// plane compares it to the target plan's caps and refuses a change that would
// leave the org above one of them.
//  - seats: the members the seat cap counts (modules/org/caps.ts countSeats);
//  - sharedMailboxes: the distinct addresses of the mailboxes the ORG owns, the
//    set the cell's mailbox cap counts (org/caps.ts); personal mailboxes, one
//    per member, never count;
//  - storageBytes: the bytes of the org's stored files;
//  - customApps: the org's own (per-org) apps; installs are instance-wide on
//    this release, so this is 0 until per-org installs exist.

import type { cloudPlanUsageSchema } from "@liaison/control-plane-contract"
import { and, sql as drizzleSql, eq, isNotNull } from "drizzle-orm"
import type { z } from "zod"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, files } from "~/db/schema/kernel"
import { countSeats, orgMailboxAddressesOn } from "~/modules/org/caps"

export type PlanUsage = z.infer<typeof cloudPlanUsageSchema>

export async function currentPlanUsage(orgId: string): Promise<PlanUsage> {
  return withSystemDb("billing-managed:usage", async (db) => {
    const seats = await countSeats(db, orgId)
    // The same set the cell's mailbox cap counts (org/caps.ts): org-owned only.
    const mailboxes = await orgMailboxAddressesOn(db, orgId)
    const [bytes] = await db
      .select({ total: drizzleSql<string>`COALESCE(SUM(${files.sizeBytes}), 0)::text` })
      .from(files)
      .where(eq(files.orgId, orgId))
    const [apps] = await db
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(appsActiveVersion)
      .where(and(isNotNull(appsActiveVersion.orgId), eq(appsActiveVersion.orgId, orgId)))
    return {
      seats,
      sharedMailboxes: mailboxes.size,
      storageBytes: Math.min(Number(bytes?.total ?? 0), Number.MAX_SAFE_INTEGER),
      customApps: Number(apps?.n ?? 0),
    }
  })
}
