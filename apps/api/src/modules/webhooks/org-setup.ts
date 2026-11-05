// SPDX-License-Identifier: FSL-1.1-ALv2
import { webhooksLogger as log } from "~/lib/logger"
import { awaitOrgApps } from "~/modules/apps/init"

/**
 * An inbound webhook may be the first touch of an org this process never
 * registered (created after boot, or by another process): set it up before the
 * route looks up the org's handlers (S3). The org id is the URL's, so it only
 * picks which org gets the setup any first touch runs: awaitOrgApps skips an id
 * that is not a UUID or names no organization row, returns at once for an org
 * already registered, and writes nothing but that org's own idempotent setup.
 * Nothing is returned to the caller; the route's own capability check
 * (signature, verify token, API key or public form) still guards the request.
 * A failure is logged and the route answers as it would anyway.
 */
export async function setUpOrgForInboundWebhook(orgId: string): Promise<void> {
  try {
    await awaitOrgApps(orgId)
  } catch (err) {
    log.error({ err, orgId }, "Org setup before an inbound webhook failed; continuing")
  }
}
