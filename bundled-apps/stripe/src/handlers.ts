// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler barrel: every handler the manifest names, by exact export name.
import type { UpstreamProbeResult, WebhookResult } from "@liaison/app-sdk"
import { handleStripeEvent, type IngestCtx } from "./dispatch"
import { type StripeVerifyBridge, type StripeVerifyParams, type StripeVerifyResult, verifyStripeDelivery } from "./verify"

export { connectionCheck, connectionPrecheck, settingsLoad } from "./tools/connection-check"

/** The kernel's verifier entry: the org's own secret, checked host-side (verify.ts). */
export async function stripeWebhookVerifier(
  params: StripeVerifyParams,
  bridge: StripeVerifyBridge,
): Promise<StripeVerifyResult> {
  return verifyStripeDelivery(params, bridge)
}

/** One verified event: ledger, re-fetch, mirror, events (dispatch.ts). */
export async function eventsHandler(payload: unknown, ctx: IngestCtx): Promise<WebhookResult> {
  return handleStripeEvent(payload, ctx)
}

/** Upstream activity is compared by the sync jobs; none is reported here yet. */
export async function probeWebhookUpstreamJob(): Promise<UpstreamProbeResult> {
  return { upstreamActivityAt: null }
}
