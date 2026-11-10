// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler barrel: every handler the manifest names, by exact export name.
//
// The skeleton refuses every webhook delivery until signature verification is
// built: an unverified body is never processed, and the probe reports no
// upstream sender, so the webhook health check does not page on an app that
// ingests nothing yet.
import type { UpstreamProbeResult, WebhookResult } from "@liaison/app-sdk"

export { connectionCheck, connectionPrecheck, settingsLoad } from "./tools/connection-check"

export interface WebhookVerifyParams {
  headers: Record<string, string>
  body: string
  method: string
  query: Record<string, string>
}

export interface WebhookVerifyResult {
  ok: boolean
  reason?: string
  replayKey?: string
}

/** No delivery is accepted yet: verification is not built, so nothing is trusted. */
export async function stripeWebhookVerifier(_params: WebhookVerifyParams): Promise<WebhookVerifyResult> {
  return { ok: false, reason: "verification_not_available" }
}

/** Never reached while the verifier refuses every delivery; stores nothing. */
export async function eventsHandler(_payload: unknown): Promise<WebhookResult> {
  return { status: 503, body: "Stripe events are not processed yet; nothing was stored." }
}

/** No events are ingested yet, so there is no upstream activity to compare against. */
export async function probeWebhookUpstreamJob(): Promise<UpstreamProbeResult> {
  return { upstreamActivityAt: null }
}
