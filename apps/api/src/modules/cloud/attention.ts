// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Automatic top-up failed": the attention item an org's admins see while the
// control plane's last billing push carries an auto top-up failure (spec S22).
//
// A provider, not an event: the item is derived from the stored billing state
// on every feed read, so repeated pushes of one failure show one item, a newer
// failure replaces it (its id names the failure's time, so the materializer
// notifies once per failure), and it is gone once the control plane clears the
// failure. Registered with the `kernel:org:admin` scope: admins only.

import type { AttentionItem } from "@liaison/shared"
import { eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { orgBillingState } from "~/db/schema/kernel"

/** Settings → Billing, where an admin fixes the card and turns auto top-up back on. */
export const BILLING_SETTINGS_PATH = "/settings/billing"

/** Kernel attention provider (registered as `kernel.cloud_billing`). */
export async function computeCloudBillingAttentionItems(
  _tx: RlsClient,
  orgId: string,
  _userId: string,
): Promise<AttentionItem[]> {
  const [row] = await withPrivilegedDb(orgId, "cloud-billing-attention", (tx) =>
    tx
      .select({ autoTopUp: orgBillingState.autoTopUp })
      .from(orgBillingState)
      .where(eq(orgBillingState.orgId, orgId))
      .limit(1),
  )
  const failure = row?.autoTopUp?.lastFailure
  if (!failure) return []
  const summary =
    failure.code === "authentication_required"
      ? "Automatic top-up needs your card to be confirmed. It is off until you confirm the card in Settings > Billing."
      : "Automatic top-up failed and is now off. Check the card in Settings > Billing."
  return [
    {
      id: `kernel:cloud_billing:auto_top_up_failed:${failure.at}`,
      app: "kernel",
      entity: "billing",
      entityId: orgId,
      kind: "admin_action",
      summary,
      // Below the urgent-email threshold (70): the feed and one notification.
      urgency: 65,
      occurredAt: failure.at,
      action: { type: "open_entity", tabType: "kernel:settings", entityId: orgId },
      metadata: { settingsRoute: BILLING_SETTINGS_PATH, failureCode: failure.code },
    },
  ]
}
