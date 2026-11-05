// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HMAC-SHA256 verifier for inbound transcript-segment webhooks.
//
// The same construction as monitoring's `monitoringWebhookVerifier`: both
// bind the shared signed-`ts` verifier in @liaison/app-sdk/webhook-verify.
// Construction: the sender signs the RAW request body with HMAC-SHA256
// (base64) under the kernel-minted `callsWebhookSecret` and sends the digest
// in `x-calls-signature`. An optional `x-calls-delivery-id` header gives
// exact-retry dedup; without it the body digest doubles as the replay key.
//
// Replay window: the envelope carries a REQUIRED `ts` covered by the
// signature; after the signature verifies, `ts` must be within the freshness
// TTL of the receiving clock (default 600s, symmetric — a future-skewed
// capture is rejected too). A payload with no parseable signed `ts` is
// REJECTED. TTL override: apps.config key `callsWebhookTtlSeconds`.
//
// The bundle runs inside QuickJS (no `node:crypto`): digest and compare go
// through the host `crypto_hmacSha256Base64` / `crypto_timingSafeEqual`
// bridges. This file MUST NOT import `node:*`; the pure-node test helper lives
// in @liaison/test-helpers/webhook-hmac.

import {
  type Base64HmacWebhookBridge,
  type SignedTsWebhookResult,
  verifySignedTsWebhook,
} from "@liaison/app-sdk/webhook-verify"

/** `scopes` is the per-handler scope grant (see HANDLER_SCOPES), consumed by the
 *  central route's `outcome.scopes` (modules/webhooks/verification.ts). */
export type VerifyResult = SignedTsWebhookResult

export const SIGNATURE_HEADER = "x-calls-signature"
export const DELIVERY_ID_HEADER = "x-calls-delivery-id"
export const WEBHOOK_SECRET_KEY = "callsWebhookSecret"
/** apps.config override for the signed-`ts` freshness window (seconds > 0). */
export const FRESHNESS_TTL_CONFIG_KEY = "callsWebhookTtlSeconds"
/** Live segments arrive every 15-30s; 10 minutes absorbs adapter buffering
 *  without letting a captured delivery live forever. */
export const DEFAULT_FRESHNESS_TTL_SECONDS = 600

export type WebhookBridge = Base64HmacWebhookBridge

/**
 * Per-handler scopes the verifier grants on success (the sanctioned
 * `outcome.scopes` mechanism — modules/webhooks/routes.ts: "The verifier MAY
 * declare per-handler scopes"). This connector owns NO tables: its handler
 * writes exclusively into knowledge documents via cross-app
 * `knowledge:create`/`update`/`get`, whose service layer authorizes against
 * the CALLER's scopes (attribution scopes are never widened by the cross-app
 * RLS union — see execute-tool.ts's actorForRls comment). The default
 * `${appName}:*` grant would leave the handler unable to write the very
 * documents that ARE its state, so the verifier grants exactly the knowledge
 * document scopes the handler's declared cross_app_calls need — nothing else
 * (no collections:manage, no sources, no archive).
 */
export const HANDLER_SCOPES = [
  "calls:*",
  "knowledge:documents:create",
  "knowledge:documents:update",
  "knowledge:documents:read",
]

/**
 * Manifest-format webhook verifier. The kernel router calls this with a
 * serialized request descriptor and expects `{ ok, replayKey, replayTtlSeconds }`
 * (apps/api/src/modules/webhooks/verification.ts). The signing secret is the
 * kernel-minted `callsWebhookSecret` (minted when the `transcript-source`
 * connection is established), read via the sandbox `config_get` bridge.
 */
export async function callsWebhookVerifier(
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
      deliveryIdLabel: "calls-delivery",
      ttlConfigKey: FRESHNESS_TTL_CONFIG_KEY,
      defaultTtlSeconds: DEFAULT_FRESHNESS_TTL_SECONDS,
      scopes: HANDLER_SCOPES,
    },
    // A missing headers object reads as no headers (never a throw).
    { headers: params.headers ?? {}, body: params.body },
    bridge,
    nowMs,
  )
}
