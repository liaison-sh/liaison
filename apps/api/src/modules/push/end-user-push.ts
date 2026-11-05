// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A PASSWORD CHANGE, A PASSWORD RESET OR A DEACTIVATION ENDS THE PERSON'S PUSH
// DELIVERY.
//
// A registered phone token or browser Web Push endpoint is where the person's
// notifications go, and a push body carries a preview of the message. It is not
// a sign-in session, so ending every session does not touch it: a device that
// someone else registered while they had the account would keep receiving the
// person's message previews after the password was changed. So every phone
// token goes, every browser profile loses its Web Push endpoint (the profile
// row stays, as one with in-tab notifications only), and every receipt
// credential is revoked, in the same transaction as the sessions. The person's
// own devices register again: the phone app at its next launch, a browser when
// notifications are turned on again in its settings.

import { and, eq, isNotNull, isNull } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import {
  browserPushSubscriptions,
  notificationDeviceCredentials,
  pushTokens,
} from "~/db/schema/kernel"

/**
 * Removes every push delivery registration of `userId`. Run it inside the
 * transaction that ends the person's sessions. Answers how many phone tokens
 * and browser endpoints it removed.
 */
export async function removeAllPushDeliveryForUser(
  tx: PrivilegedDb,
  userId: string,
): Promise<{ phones: number; browsers: number }> {
  const phones = await tx
    .delete(pushTokens)
    .where(eq(pushTokens.userId, userId))
    .returning({ id: pushTokens.id })
  const browsers = await tx
    .update(browserPushSubscriptions)
    .set({ endpoint: null, p256dh: null, auth: null })
    .where(
      and(
        eq(browserPushSubscriptions.userId, userId),
        isNotNull(browserPushSubscriptions.endpoint),
      ),
    )
    .returning({ id: browserPushSubscriptions.id })
  await tx
    .update(notificationDeviceCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(notificationDeviceCredentials.userId, userId),
        isNull(notificationDeviceCredentials.revokedAt),
      ),
    )
  return { phones: phones.length, browsers: browsers.length }
}
