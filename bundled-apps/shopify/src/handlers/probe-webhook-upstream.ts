// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Webhook upstream probe: tells the kernel when this shop last changed an order.
//
// Named by the manifest's `webhookHealth: { "probe": "probe-webhook-upstream" }`.
// Silence alone cannot tell a quiet shop from a dead subscription, so the kernel
// judges this app by evidence: this job returns the newest order `updatedAt`
// Shopify knows about, and the kernel reports a missed delivery only when that
// change is older than its delivery grace and no webhook has arrived since
// (modules/webhooks/ingest-health.ts in the API).
//
// Orders only: every order change fires `orders/updated`, which this app always
// subscribes to, so an order newer than our last delivery is a delivery we
// missed. Products and customers depend on optional scopes and are left out.
//
// Contract: `{ upstreamActivityAt: ISO }` when the shop has orders,
// `{ upstreamActivityAt: null }` when there is no live sender (no orders, or the
// shop is disconnected). When Shopify cannot be reached the job returns
// `{ probed: false, reason }`, which is no report: if that persists the kernel
// lists the probe as stale rather than reading an unreachable shop as a quiet one.
import type { AppContext, UpstreamProbeResult } from "@liaison/app-sdk"
import { ensureInstallMetadata, getShopifyClient } from "../lib/get-client"

const QUERY = `
  query LatestOrderChange {
    orders(first: 1, sortKey: UPDATED_AT, reverse: true) {
      edges { node { updatedAt } }
    }
  }
`

export type { UpstreamProbeResult }

export async function probeWebhookUpstreamJob(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<UpstreamProbeResult> {
  const row = await ensureInstallMetadata(ctx)
  if (!row?.shopDomain || row.connectionStatus === "disconnected") {
    return { upstreamActivityAt: null }
  }
  let client
  try {
    client = await getShopifyClient(ctx)
  } catch (err) {
    return { probed: false, reason: `no client: ${(err as Error).message}` }
  }
  try {
    const data = await client.query<{
      orders?: { edges?: Array<{ node?: { updatedAt?: string | null } }> }
    }>(QUERY, {})
    const updatedAt = data.orders?.edges?.[0]?.node?.updatedAt ?? null
    return { upstreamActivityAt: updatedAt }
  } catch (err) {
    ctx.logger.warn(`[probe-webhook-upstream] ${(err as Error).message}`)
    return { probed: false, reason: (err as Error).message }
  }
}
