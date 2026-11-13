// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HMAC-SHA256 verifier for inbound monitoring alert webhooks.
//
// The alert source signs the RAW request body with HMAC-SHA256 (base64) under
// the kernel-minted `monitoringWebhookSecret` and sends the digest in the
// `x-monitoring-signature` header. An optional `x-monitoring-delivery-id`
// header gives exact-retry dedup; without it the body digest doubles as the
// replay key (an identical redelivery dedups, a new alert body does not).
//
// Replay window (M3C-01): the signature alone would let a captured delivery be
// replayed forever under fresh delivery-ids (bounded impact — dedup folds
// replays into count bumps — but bounded is better than forever). The envelope
// already carries a REQUIRED `ts` field covered by the signature, so after the
// signature verifies, `ts` must be within the freshness TTL of the receiving
// clock (default 10 minutes, symmetric: too far in the FUTURE is rejected too —
// otherwise a skewed-clock capture extends the replay window). A payload with
// no parseable signed `ts` is REJECTED: every first-party sender (watchtower /
// cockpit / infra-cost-pulse, and the send-webhook e2e harness) already sends
// a fresh ISO `ts`, and the alert envelope schema requires it anyway, so
// reject-if-absent closes the hole without breaking any real sender.
// TTL override: apps.config key `monitoringAlertTtlSeconds` (positive number).
//
// The construction itself is the shared signed-`ts` verifier in
// @liaison/app-sdk/webhook-verify; this file binds monitoring's header names,
// config keys and delivery label. The bundle runs in the sandbox, with no
// `node:crypto`, and never holds the secret: the host checks the signature
// with it (`crypto_verifyHmacForConfig`). This file
// MUST NOT import `node:*`; the pure-node test helper lives in
// @liaison/test-helpers/webhook-hmac.

import {
  type Base64HmacWebhookBridge,
  type SignedTsWebhookResult,
  verifySignedTsWebhook,
} from "@liaison/app-sdk/webhook-verify"

export type VerifyResult = SignedTsWebhookResult

export const SIGNATURE_HEADER = "x-monitoring-signature"
export const DELIVERY_ID_HEADER = "x-monitoring-delivery-id"
export const WEBHOOK_SECRET_KEY = "monitoringWebhookSecret"
/** apps.config override for the signed-`ts` freshness window (seconds > 0). */
export const FRESHNESS_TTL_CONFIG_KEY = "monitoringAlertTtlSeconds"
/** Generous default: alert pipelines can lag, replays should not live forever. */
export const DEFAULT_FRESHNESS_TTL_SECONDS = 600

export type WebhookBridge = Base64HmacWebhookBridge

/**
 * Manifest-format webhook verifier. The kernel router calls this with a
 * serialized request descriptor and expects `{ ok, replayKey, replayTtlSeconds }`
 * (see apps/api/src/modules/webhooks/verification.ts). The signing secret is
 * the kernel-minted `monitoringWebhookSecret` in apps.config, used host-side
 * only (the verifier names its key).
 */
export async function monitoringWebhookVerifier(
  params: {
    headers: Record<string, string>
    body: string
    method: string
    query: Record<string, string>
  },
  bridge: WebhookBridge,
  /** Injectable clock for tests; the kernel calls with two args → Date.now(). */
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  return verifySignedTsWebhook(
    {
      secretConfigKey: WEBHOOK_SECRET_KEY,
      signatureHeader: SIGNATURE_HEADER,
      deliveryIdHeader: DELIVERY_ID_HEADER,
      deliveryIdLabel: "monitoring-delivery",
      ttlConfigKey: FRESHNESS_TTL_CONFIG_KEY,
      defaultTtlSeconds: DEFAULT_FRESHNESS_TTL_SECONDS,
    },
    params,
    bridge,
    nowMs,
  )
}
