// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Webhook upstream probe: tells the kernel when Pennylane last received a supplier e-invoice.
//
// The kernel pages "webhook-ingest" when an app's webhooks go silent. Received e-invoices come
// every few days, so a silence window alone reads a quiet inbox as a dead subscription and pages
// every hour. This job gives the kernel the missing evidence: the newest received supplier
// e-invoice Pennylane lists, read live (never the local snapshot), so the kernel pages only when
// an invoice arrived more than its delivery grace ago and no webhook has reached us since
// (modules/webhooks/ingest-health.ts in the API).
//
// Received invoices only: each one fires `supplier_invoice.e_invoicing_received`, which our
// subscription always carries. Customer invoice status changes are left out: nothing proves every
// status change Pennylane shows was announced by a webhook.
//
// Contract (named by the manifest's `webhookHealth.probe`): `{ upstreamActivityAt: ISO }` when an e-invoice was
// received, `{ upstreamActivityAt: null }` when there is no live sender (Pennylane not connected,
// no webhook subscription, no reception address, nothing received yet). When Pennylane cannot be
// reached, or its connection exists but cannot be used, the job answers `{ probed: false, reason }`:
// the kernel lists the probe as stale instead of reading an unreachable Pennylane as a quiet one.
import type { UpstreamProbeResult } from "@liaison/app-sdk"
import type { PennylaneToolCtx } from "../ctx"
import { getClient, PennylaneConnectionError } from "../lib/get-client"
import { PennylaneClient } from "../lib/pennylane-client"
import { receptionAddresses } from "../received/received"
import { readAppConfig, SUBSCRIPTION_KEY } from "./webhooks"

export const RECEIVED_EVENT = "supplier_invoice.e_invoicing_received"

export type { UpstreamProbeResult }

interface ReceivedRow {
  id: number
  created_at?: string | null
  e_invoicing?: unknown
}

export async function probeWebhookUpstream(ctx: PennylaneToolCtx): Promise<UpstreamProbeResult> {
  const subscription = await readAppConfig<{ events?: unknown }>(ctx, SUBSCRIPTION_KEY)
  const events = Array.isArray(subscription?.events) ? subscription.events : []
  if (!events.includes(RECEIVED_EVENT)) return { upstreamActivityAt: null }
  let c: PennylaneClient
  try {
    c = ctx.__client instanceof PennylaneClient ? ctx.__client : (await getClient(ctx)).client
  } catch (e) {
    // No connection at all means no sender. A connection that exists but cannot be used (incomplete
    // credentials, firm scope without its company id) is a sender we cannot look at.
    if (e instanceof PennylaneConnectionError && e.notConnected) return { upstreamActivityAt: null }
    return { probed: false, reason: `no client: ${(e as Error).message}` }
  }
  try {
    let newest: string | null = null
    for (const address of await receptionAddresses(c)) {
      const page = await c.list<ReceivedRow>("/supplier_invoices", {
        filter: [{ field: "electronic_billing_address", operator: "eq", value: address }],
        sort: "-id",
        limit: 1,
      })
      const at = page.items.find((i) => i.e_invoicing)?.created_at ?? null
      if (at && (newest === null || Date.parse(at) > Date.parse(newest))) newest = at
    }
    return { upstreamActivityAt: newest }
  } catch (e) {
    const reason = (e as Error).message
    ctx.logger?.warn?.(`[probe-webhook-upstream] ${reason}`)
    return { probed: false, reason }
  }
}
