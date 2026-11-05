// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 E2E harness — `dispatchBoxtalWebhook` helper.
//
// Signs a Boxtal v3 webhook body with HMAC-SHA256 (base64) using the
// kernel-minted `boxtalWebhookSecret` and POSTs it to the kernel manifest
// webhook router at `${serverUrl}/webhooks/<orgId>/boxtal/<endpoint>` (no
// `/api` prefix — verified in `apps/api/src/app.ts` and the Shopify dispatch
// helper).
//
// Notes (verified against the Boxtal bundle):
//   * The verifier (`bundled-apps/boxtal/src/lib/hmac.ts`) computes
//     HMAC-SHA256(secret, rawBody) → base64 and reads the header
//     `x-bxt-signature`. The dedup `replayKey` prefers `x-bxt-delivery-id`.
//   * The endpoint slug is the kebab manifest webhook name: `tracking-changed`
//     or `document-created`.
//   * Stringify the body ONCE so the signed bytes match the sent bytes.
import { createHmac } from "node:crypto"

export interface DispatchBoxtalWebhookOptions {
  serverUrl: string
  orgId: string
  /** Kebab manifest webhook name: `tracking-changed` | `document-created`. */
  endpoint: "tracking-changed" | "document-created"
  /** Webhook payload — serialized to JSON exactly once. */
  body: Record<string, unknown>
  /** The kernel-minted `boxtalWebhookSecret` (returned by installBoxtalApp). */
  secret: string
  /**
   * Per-delivery dedup id (`x-bxt-delivery-id`). Defaults to a fresh UUID so
   * every call dedups as new. Pass an explicit value to test dedup behaviour,
   * or `null` to OMIT the header (exercises the fallback dedup key).
   */
  deliveryId?: string | null
  /** Override the signature (negative-path tests). */
  signatureOverride?: string
}

export interface DispatchBoxtalWebhookResult {
  status: number
  body: unknown
}

export async function dispatchBoxtalWebhook(
  opts: DispatchBoxtalWebhookOptions,
): Promise<DispatchBoxtalWebhookResult> {
  const rawBody = JSON.stringify(opts.body)
  const signature =
    opts.signatureOverride ??
    createHmac("sha256", opts.secret).update(rawBody, "utf8").digest("base64")

  const url = `${trimTrailingSlash(opts.serverUrl)}/webhooks/${encodeURIComponent(opts.orgId)}/boxtal/${encodeURIComponent(opts.endpoint)}`

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-bxt-signature": signature,
  }
  if (opts.deliveryId !== null) {
    headers["x-bxt-delivery-id"] = opts.deliveryId ?? crypto.randomUUID()
  }

  const resp = await fetch(url, { method: "POST", headers, body: rawBody })
  let parsed: unknown = null
  const text = await resp.text()
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  return { status: resp.status, body: parsed }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s
}
